import { isAbsolute, relative, resolve } from "node:path";
import type { CodexContentPart, CodexParsedRequest } from "../../types";

export type FreebuffSandbox = "dangerFullAccess" | "readOnly" | "workspaceWrite";

export interface FreebuffTurnEnvironment {
  cwd: string;
  sandbox: FreebuffSandbox;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function contentText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function rawMessageText(value: JsonObject): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" && turnId.trim() ? turnId : undefined;
}

function clientTurnMetadata(parsed: CodexParsedRequest): JsonObject | undefined {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); } catch { return undefined; }
  }
  return record(raw);
}

function environmentMessage(value: unknown): string | undefined {
  const message = record(value);
  if (!message || message.type !== "message" || message.role !== "user") return undefined;
  const text = rawMessageText(message).trim();
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? text : undefined;
}

function environmentFromInput(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (record(input[index])?.role === "user") {
      activeUserIndex = index;
      break;
    }
  }
  if (activeUserIndex < 1) return undefined;

  const metadata = clientTurnMetadata(parsed);
  const currentTurnId = typeof metadata?.turn_id === "string" ? metadata.turn_id : undefined;
  const activeTurnId = itemTurnId(input[activeUserIndex]);
  const authoritativeTurnId = currentTurnId ?? activeTurnId;
  // Never trust a user-authored environment-shaped history item without native turn provenance.
  if (!authoritativeTurnId || (currentTurnId && activeTurnId && activeTurnId !== currentTurnId)) return undefined;

  let candidateIndex = activeUserIndex - 1;
  while (candidateIndex >= 0) {
    const candidate = record(input[candidateIndex]);
    if (candidate?.type === "message" && candidate.role === "developer") {
      const developerTurnId = itemTurnId(candidate);
      const serverOwned = typeof candidate.id === "string" && candidate.id.length > 0;
      if (developerTurnId !== authoritativeTurnId && (!serverOwned || developerTurnId !== undefined)) {
        return undefined;
      }
      candidateIndex -= 1;
      continue;
    }
    break;
  }

  const candidate = record(input[candidateIndex]);
  const candidateTurnId = itemTurnId(candidate);
  const serverOwned = typeof candidate?.id === "string" && candidate.id.length > 0;
  if (candidateTurnId !== authoritativeTurnId && (!serverOwned || candidateTurnId !== undefined)) {
    return undefined;
  }
  return environmentMessage(candidate);
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const inputEnvironment = environmentFromInput(parsed);
  if (inputEnvironment) return inputEnvironment;
  const system = parsed.context.systemPrompt ?? [];
  const developer = parsed.context.messages
    .filter(message => message.role === "developer")
    .map(message => contentText(message.content));
  return [...system, ...developer].join("\n");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function pathIdentity(value: string): string {
  return process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
}

function matchesPath(root: string, path: string): boolean {
  const nested = relative(pathIdentity(root), pathIdentity(path));
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function uniqueAbsolutePaths(values: string[], field: string): string[] {
  if (values.length === 0) throw new Error(`Freebuff turn is missing ${field} in trusted Codex environment context`);
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.some(value => !isAbsolute(value))) {
    throw new Error(`Freebuff ${field} must contain absolute paths`);
  }
  const unique = new Map<string, string>();
  for (const value of decoded.map(value => resolve(value))) {
    if (!unique.has(pathIdentity(value))) unique.set(pathIdentity(value), value);
  }
  return [...unique.values()];
}

function metadataWorkspaceRoots(parsed: CodexParsedRequest): string[] {
  const workspaces = record(clientTurnMetadata(parsed)?.workspaces);
  if (!workspaces) return [];
  const roots = Object.keys(workspaces);
  if (roots.some(root => !isAbsolute(root))) return [];
  return [...new Set(roots.map(pathIdentity))];
}

function environmentCwdMatches(text: string, preferredRoots: string[]): string[] {
  const sections = [...text.matchAll(/<environments>([\s\S]*?)<\/environments>/gi)];
  if (sections.length > 1) return [];
  if (sections.length === 1) {
    const section = sections[0]!;
    const outside = text.replace(section[0], "");
    if (/<cwd>[^<]*<\/cwd>/i.test(outside)) return [];
    const environments = [...section[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)];
    const primary = environments.filter(match => /\bprimary\s*=\s*["']true["']/i.test(match[1] ?? ""));
    if (primary.length > 1) return [];
    const source = primary.length === 1 ? primary[0]![2]! : section[1]!;
    const candidates = [...source.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
    if (candidates.length === 1 || primary.length === 1) return candidates;
    if (preferredRoots.length === 0) return [];
    const exact = candidates.filter(candidate => preferredRoots.some(root => pathIdentity(root) === pathIdentity(candidate)));
    if (exact.length === 1) return exact;
    const contained = candidates.filter(candidate => preferredRoots.some(root => matchesPath(root, candidate)));
    return contained.length === 1 ? contained : [];
  }

  const cwdMatches = [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
  if (cwdMatches.length > 0 || /<\/?cwd\b/i.test(text)) return cwdMatches;
  const roots = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/gi)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/gi)].map(match => match[1] ?? ""));
  return roots.length > 0 ? [roots[0]!] : [];
}

function sandboxFromEnvironment(text: string): FreebuffSandbox | undefined {
  const unrestricted = /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(text)
    || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const restrictedFileSystem = /<permission_profile\s+type=["']managed["'][^>]*>[\s\S]*?<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/i.exec(text);
  const restrictedHasWriteEntry = restrictedFileSystem !== null
    && /<entry\s+access=["']write["'][^>]*>/i.test(restrictedFileSystem[1]!);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text) || restrictedHasWriteEntry;
  const readOnly = /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text)
    || (restrictedFileSystem !== null && !restrictedHasWriteEntry);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

export function extractFreebuffTurnEnvironment(parsed: CodexParsedRequest): FreebuffTurnEnvironment {
  const text = trustedEnvironmentText(parsed);
  const cwdCandidates = uniqueAbsolutePaths(environmentCwdMatches(text, metadataWorkspaceRoots(parsed)), "cwd");
  if (cwdCandidates.length !== 1) throw new Error("Freebuff turn has conflicting trusted Codex cwd values");
  const cwd = cwdCandidates[0]!;
  const rootMatches = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd))) {
    throw new Error("Freebuff cwd is outside the trusted Codex workspace roots");
  }
  const sandbox = sandboxFromEnvironment(text);
  if (!sandbox) throw new Error("Freebuff turn requires one explicit trusted Codex sandbox mode");
  return { cwd, sandbox };
}
