import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  CodebuffClient,
  type CodebuffClientOptions,
  type MessageContent,
  type RunState,
} from "@codebuff/sdk";
import { extractFreebuffTurnEnvironment } from "./environment";
import type { ProviderAdapter, IncomingMeta } from "../base";
import type {
  CodexContentPart,
  CodexMessage,
  CodexParsedRequest,
  CodexProviderConfig,
  CodexUsage,
} from "../../types";
import { estimateTokens } from "../../lib/token-estimate";
import { FREEBUFF_AGENT, FREEBUFF_INPUT_CHAR_LIMIT, FREEBUFF_MODEL_ID } from "../../freebuff-models";
import { freebuffRootAgentDefinitionFor } from "./agent-definition";
import { freebuffLoginRequiredMessage } from "../../freebuff-auth";
import {
  fetchFreebuffAd,
  FREEBUFF_AD_MARKER,
  FREEBUFF_HOUSE_AD,
  recordFreebuffAdImpression,
  renderFreebuffAd,
  type FreebuffAd,
  type FreebuffFetch,
} from "../../freebuff-ads";
import {
  getFreebuffSessionManager,
  type ActiveFreebuffSession,
  type FreebuffSessionManager,
} from "./session";
import { withFreebuffRequestContext } from "./request-context";

export const FREEBUFF_ADAPTER_HEARTBEAT_MS = 2_000;

interface ActiveFreebuffRun {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

/** Tracks SDK runs so the existing local service controls can cancel them by trace id. */
export class FreebuffRunRegistry {
  private readonly active = new Map<string, Set<ActiveFreebuffRun>>();

  activeCount(): number {
    let count = 0;
    for (const runs of this.active.values()) count += runs.size;
    return count;
  }

  register(traceId: string, controller: AbortController): () => void {
    let finish!: () => void;
    const done = new Promise<void>(resolveDone => { finish = resolveDone; });
    const entry: ActiveFreebuffRun = { controller, done, finish };
    const runs = this.active.get(traceId) ?? new Set<ActiveFreebuffRun>();
    runs.add(entry);
    this.active.set(traceId, runs);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runs.delete(entry);
      if (runs.size === 0) this.active.delete(traceId);
      finish();
    };
  }

  async cancelTrace(traceId: string, reason = new Error("Active Freebuff run cancelled")): Promise<number> {
    const runs = [...(this.active.get(traceId) ?? [])];
    for (const run of runs) {
      if (!run.controller.signal.aborted) run.controller.abort(reason);
    }
    await Promise.all(runs.map(run => run.done));
    return runs.length;
  }

  async clear(reason = new Error("Active Freebuff runs cancelled")): Promise<number> {
    const runs = [...this.active.values()].flatMap(entries => [...entries]);
    for (const run of runs) {
      if (!run.controller.signal.aborted) run.controller.abort(reason);
    }
    await Promise.all(runs.map(run => run.done));
    return runs.length;
  }
}

export const freebuffRuns = new FreebuffRunRegistry();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestIdentity(parsed: CodexParsedRequest): string {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const metadataValue = metadata?.["x-codex-turn-metadata"];
  let canonicalMetadata: unknown = metadataValue;
  if (typeof metadataValue === "string") {
    try { canonicalMetadata = JSON.parse(metadataValue); } catch { canonicalMetadata = metadataValue; }
  }
  const identity = record(canonicalMetadata);
  return JSON.stringify({
    threadId: identity?.thread_id,
    turnId: identity?.turn_id,
    promptCacheKey: body?.prompt_cache_key,
    model: parsed.modelId,
    fallback: identity ? undefined : parsed.context.messages,
  });
}

export function freebuffTraceId(_provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  return createHash("sha256").update(requestIdentity(parsed)).digest("hex").slice(0, 48);
}

function freebuffAdSessionId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const metadataValue = metadata?.["x-codex-turn-metadata"];
  let canonicalMetadata: unknown = metadataValue;
  if (typeof metadataValue === "string") {
    try { canonicalMetadata = JSON.parse(metadataValue); } catch { canonicalMetadata = metadataValue; }
  }
  const threadId = record(canonicalMetadata)?.thread_id;
  if (typeof threadId === "string" && threadId.trim()) return threadId.trim();
  const promptCacheKey = body?.prompt_cache_key;
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) return promptCacheKey.trim();
  return provider.freebuff?.traceId ?? freebuffTraceId(provider, parsed);
}

function contentText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(part => part.type === "text" ? part.text : "[image attached]").join("\n");
}

type FreebuffInputMessage = Extract<CodexMessage, { role: "user" | "agentMessage" }>;

function currentInputMessage(parsed: CodexParsedRequest): FreebuffInputMessage | undefined {
  return [...parsed.context.messages].reverse().find(
    (message): message is FreebuffInputMessage => message.role === "user" || message.role === "agentMessage",
  );
}

function formatMessage(message: CodexMessage): string {
  const role = message.role === "agentMessage" ? `agent:${message.author ?? "unknown"}` : message.role;
  if (message.role === "assistant") {
    if (message.content.length === 1
      && message.content[0]?.type === "text"
      && message.content[0].text.startsWith(FREEBUFF_AD_MARKER)) return "";
    const content = message.content.map(part => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return `[thinking] ${part.thinking}`;
      return `[tool call ${part.name}] ${JSON.stringify(part.arguments)}`;
    }).join("\n");
    return `[${role}]\n${content}`;
  }
  if (message.role === "toolResult") {
    return `[tool result ${message.toolName}]\n${contentText(message.content)}${message.isError ? "\n[tool error]" : ""}`;
  }
  return `[${role}]\n${contentText(message.content)}`;
}

function dataImage(part: CodexContentPart): MessageContent | undefined {
  if (part.type !== "image") return undefined;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(part.imageUrl);
  if (!match) return undefined;
  return { type: "image", image: match[2]!, mediaType: match[1]! };
}

function compilePrompt(parsed: CodexParsedRequest): { prompt: string; content?: MessageContent[] } {
  const sections: string[] = [];
  if (parsed.context.systemPrompt?.length) {
    sections.push(`[system]\n${parsed.context.systemPrompt.join("\n\n")}`);
  }
  sections.push(...parsed.context.messages.map(formatMessage).filter(Boolean));
  const current = currentInputMessage(parsed);
  const images = current && typeof current.content !== "string"
    ? current.content.map(dataImage).filter((part): part is MessageContent => part !== undefined)
    : [];
  return {
    prompt: sections.join("\n\n").trim() || "Continue the coding task.",
    ...(images.length > 0 ? { content: images } : {}),
  };
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  const object = record(value);
  if (!object) return "";
  if (typeof object.text === "string") return object.text;
  if (typeof object.thinking === "string") return object.thinking;
  if (object.type === "structuredOutput") {
    return object.value === null ? "null" : JSON.stringify(object.value);
  }
  if (object.type === "lastMessage" || object.type === "allMessages") {
    return textFromValue(object.value);
  }
  if (object.role === "assistant") return textFromValue(object.content);
  return "";
}

function executionContext(parsed: CodexParsedRequest, provider: CodexProviderConfig): {
  cwd: string;
  sandbox: "readOnly" | "workspaceWrite" | "dangerFullAccess";
} {
  const configuredCwd = provider.freebuff?.cwd?.trim();
  if (configuredCwd) {
    if (!isAbsolute(configuredCwd)) throw new Error("Freebuff cwd must be an absolute path");
    return {
      cwd: resolve(configuredCwd),
      sandbox: provider.freebuff?.sandbox ?? "workspaceWrite",
    };
  }
  const environment = extractFreebuffTurnEnvironment(parsed);
  return { cwd: environment.cwd, sandbox: environment.sandbox };
}

function readOnlyOverrides(): NonNullable<CodebuffClientOptions["overrideTools"]> {
  const deny = async () => [{
    type: "json" as const,
    value: { errorMessage: "This Freebuff turn is read-only; file writes and shell commands are disabled." },
  }];
  return {
    write_file: deny,
    str_replace: deny,
    apply_patch: deny,
    run_terminal_command: deny,
    run_file_change_hooks: deny,
  } as NonNullable<CodebuffClientOptions["overrideTools"]>;
}

export interface FreebuffAdapterDependencies {
  createClient?: (options: CodebuffClientOptions) => Pick<CodebuffClient, "run">;
  fetchImpl?: FreebuffFetch;
  /** Test/in-process override for official Freebuff session admission. */
  ensureSession?: (
    token: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<ActiveFreebuffSession>;
  sessionManager?: FreebuffSessionManager;
}

export function createFreebuffAdapter(
  provider: CodexProviderConfig,
  dependencies: FreebuffAdapterDependencies = {},
): ProviderAdapter {
  return {
    name: "freebuff",
    async runTurn(parsed: CodexParsedRequest, incoming: IncomingMeta, emit): Promise<void> {
      const context = executionContext(parsed, provider);
      const current = currentInputMessage(parsed);
      const currentInputChars = current ? contentText(current.content).length : 0;
      if (currentInputChars > FREEBUFF_INPUT_CHAR_LIMIT) {
        emit({
          type: "error",
          message: `This Freebuff message contains ${currentInputChars.toLocaleString("en-US")} characters, exceeding the bridge safety limit of ${FREEBUFF_INPUT_CHAR_LIMIT.toLocaleString("en-US")} characters per message based on the Freebuff Web input boundary. Shorten the current message and retry.`,
          status: 400,
          errorType: "invalid_request_error",
          code: "context_length_exceeded",
          retryable: false,
        });
        return;
      }
      const { prompt, content } = compilePrompt(parsed);
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(incoming.abortSignal?.reason);
      if (incoming.abortSignal?.aborted) forwardAbort();
      else incoming.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
      const release = freebuffRuns.register(
        provider.freebuff?.traceId ?? freebuffTraceId(provider, parsed),
        controller,
      );
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), FREEBUFF_ADAPTER_HEARTBEAT_MS);
      let usage: CodexUsage | undefined;
      let emittedText = false;
      let adPromise: Promise<FreebuffAd | null> = Promise.resolve(null);
      try {
        const authToken = provider.freebuff?.authToken
          ?? provider.freebuff?.apiKey
          ?? process.env.CODEBUFF_API_KEY?.trim();
        const credentialsPath = provider.freebuff?.credentialsPath;
        if (!authToken) {
          throw new Error(freebuffLoginRequiredMessage(credentialsPath ?? "~/.config/manicode/credentials.json"));
        }
        const sessionModel = provider.freebuff?.model ?? FREEBUFF_MODEL_ID;
        const session = await (dependencies.ensureSession
          ? dependencies.ensureSession(authToken, sessionModel, controller.signal)
          : (dependencies.sessionManager ?? getFreebuffSessionManager(provider.baseUrl))
            .ensure(authToken, sessionModel, controller.signal));
        if (controller.signal.aborted) {
          emit({ type: "incomplete", reason: "cancelled", message: "Freebuff run cancelled", usage, retryable: false });
          return;
        }
        if (!parsed._compactionRequest && provider.freebuff?.authSource !== "legacy-api-key") {
          const currentUserMessage = [...parsed.context.messages].reverse().find(
            message => message.role === "user",
          );
          adPromise = fetchFreebuffAd({
            baseUrl: provider.baseUrl,
            authToken,
            userMessage: currentUserMessage ? contentText(currentUserMessage.content) : "coding task",
            sessionId: freebuffAdSessionId(provider, parsed),
            signal: controller.signal,
            fetchImpl: dependencies.fetchImpl,
          });
        }
        const agent = provider.freebuff?.agent ?? FREEBUFF_AGENT;
        const rootAgentDefinition = freebuffRootAgentDefinitionFor(agent);
        const clientOptions: CodebuffClientOptions = {
          // The official CLI passes its saved authToken through the SDK's apiKey field. This is
          // an SDK naming detail; users do not create or paste an API key in this flow.
          apiKey: authToken,
          cwd: context.cwd,
          maxAgentSteps: provider.freebuff?.maxAgentSteps ?? 20,
          ...(rootAgentDefinition
            ? { agentDefinitions: [rootAgentDefinition] }
            : {}),
          ...(context.sandbox === "readOnly" ? { overrideTools: readOnlyOverrides() } : {}),
        };
        const client = dependencies.createClient
          ? dependencies.createClient(clientOptions)
          : new CodebuffClient(clientOptions);
        const handleStreamChunk: NonNullable<CodebuffClientOptions["handleStreamChunk"]> = chunk => {
          if (typeof chunk === "string") {
            if (chunk) {
              emittedText = true;
              emit({ type: "text_delta", text: chunk, phase: "final_answer" });
            }
          } else if (chunk.type === "reasoning_chunk") {
            if (chunk.chunk) emit({ type: "thinking_delta", thinking: chunk.chunk });
          } else if (chunk.chunk) {
            emit({ type: "text_delta", text: chunk.chunk, phase: "commentary" });
          }
        };
        const result: RunState = await withFreebuffRequestContext(
          {
            instanceId: session.instanceId,
            traceSessionId: randomUUID(),
            ...(parsed.options.reasoning ? { reasoningEffort: parsed.options.reasoning } : {}),
          },
          () => client.run({
            agent,
            prompt,
            ...(content ? { content } : {}),
            signal: controller.signal,
            costMode: "free",
            handleStreamChunk,
          }),
        );
        if (controller.signal.aborted) {
          emit({ type: "incomplete", reason: "cancelled", message: "Freebuff run cancelled", usage, retryable: false });
          return;
        }
        if (result.output.type === "error") {
          emit({
            type: "error",
            message: result.output.message,
            ...(typeof result.output.statusCode === "number" ? { status: result.output.statusCode } : {}),
            retryable: false,
          });
          return;
        }
        if (!emittedText) {
          const output = textFromValue(result.output);
          if (output) {
            emittedText = true;
            emit({ type: "text_delta", text: output, phase: "final_answer" });
          }
        }
        if (emittedText && !parsed._compactionRequest) {
          const ad = await adPromise ?? FREEBUFF_HOUSE_AD;
          emit({ type: "text_delta", text: renderFreebuffAd(ad), phase: "commentary" });
          if (ad !== FREEBUFF_HOUSE_AD) {
            void recordFreebuffAdImpression({
              baseUrl: provider.baseUrl,
              authToken,
              ad,
              fetchImpl: dependencies.fetchImpl,
            });
          }
        }
        const estimatedUsage = usage ?? {
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(emittedText ? textFromValue(result.output) : ""),
          estimated: true,
        };
        emit({ type: "done", usage: estimatedUsage, stopReason: "stop", endTurn: true });
      } catch (error) {
        if (controller.signal.aborted) {
          emit({ type: "incomplete", reason: "cancelled", message: "Freebuff run cancelled", usage, retryable: false });
        } else {
          emit({ type: "error", message: error instanceof Error ? error.message : String(error), retryable: false });
        }
      } finally {
        clearInterval(heartbeat);
        incoming.abortSignal?.removeEventListener("abort", forwardAbort);
        release();
      }
    },
  };
}
