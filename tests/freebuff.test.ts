import { expect, test } from "bun:test";
import type { CodebuffClient, CodebuffClientOptions, RunOptions, RunState } from "@codebuff/sdk";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreebuffAdapter } from "../src/adapters/freebuff";
import { FREEBUFF_AD_MARKER, FREEBUFF_HOUSE_AD, renderFreebuffAd } from "../src/freebuff-ads";
import { extractFreebuffTurnEnvironment } from "../src/adapters/freebuff/environment";
import { FreebuffSessionManager } from "../src/adapters/freebuff/session";
import { resolveFreebuffAuth } from "../src/freebuff-auth";
import { defaultConfig, loadConfigForSetup, providerConfig } from "../src/config";
import {
  FREEBUFF_MANAGED_ROUTE_COMMENT,
  getCodexManagedModelCatalogPath,
} from "../src/codex-integration-shared";
import { installCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { installRoute } from "../src/codex-integration-route";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";
import type { AdapterEvent } from "../src/types";

function parsedRequest(model = "freebuff/base") {
  return parseRequest({
    model,
    stream: false,
    instructions: "Follow the repository instructions.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Explain the next implementation step." }],
    }],
  });
}

function testSession() {
  return { instanceId: "test-freebuff-instance", model: "deepseek/deepseek-v4-flash" };
}

test("Freebuff adapter forwards the native SDK run and emits its text output", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-adapter-"));
  try {
    const config = defaultConfig("full");
    const credentialsPath = join(root, "credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({
      default: { name: "Test user", email: "test@example.com", authToken: "official-session-token" },
    }), { mode: 0o600 });
    config.freebuff = {
      credentialsPath,
      cwd: root,
      agent: "codebuff/test@latest",
      maxAgentSteps: 7,
    };
    const provider = providerConfig(config);
    let clientOptions: CodebuffClientOptions | undefined;
    let runOptions: RunOptions | undefined;
    const adapter = createFreebuffAdapter(provider, {
      ensureSession: async () => testSession(),
      fetchImpl: async (input) => {
        if (String(input).endsWith("/api/v1/ads")) {
          return new Response(JSON.stringify({ ads: [{
            title: "Freebuff Pro",
            adText: "3 more a day. $8/mo",
            cta: "See plans",
            url: "https://freebuff.com/plans",
            clickUrl: "https://www.codebuff.com/click/test",
            impUrl: "https://www.codebuff.com/impression/test",
          }] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      createClient(options) {
        clientOptions = options;
        return {
          async run(options: RunOptions): Promise<RunState> {
            runOptions = options;
            await clientOptions?.handleStreamChunk?.("The next step is ready.");
            // The SDK can report the same final text through its print-mode event
            // path as well; the adapter must not forward it a second time.
            await clientOptions?.handleEvent?.({ type: "text", text: "The next step is ready." });
            return {
              output: {
                type: "lastMessage",
                value: [{ role: "assistant", content: [{ type: "text", text: "The next step is ready." }] }],
              },
            };
          },
        } as Pick<CodebuffClient, "run">;
      },
    });
    const events: AdapterEvent[] = [];

    await adapter.runTurn(parsedRequest(), { headers: new Headers() }, event => events.push(event));

    expect(clientOptions).toMatchObject({ apiKey: "official-session-token", cwd: root, maxAgentSteps: 7 });
    expect(runOptions).toMatchObject({
      agent: "codebuff/test@latest",
      costMode: "free",
      prompt: expect.stringContaining("Explain the next implementation step."),
    });
    expect(events.filter(event => event.type === "text_delta")).toEqual([
      {
        type: "text_delta",
        text: "The next step is ready.",
        phase: "final_answer",
      },
      expect.objectContaining({
        type: "text_delta",
        text: expect.stringContaining(FREEBUFF_AD_MARKER),
        phase: "commentary",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect((events.at(-1) as Extract<AdapterEvent, { type: "done" }>).usage?.estimated).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff display ads are omitted from the next provider prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-ad-history-"));
  try {
    const config = defaultConfig("full");
    config.freebuff = { apiKey: "cb-test-key", credentialsPath: join(root, "credentials.json"), cwd: root };
    const provider = providerConfig(config);
    let providerPrompt = "";
    const adapter = createFreebuffAdapter(provider, {
      ensureSession: async () => testSession(),
      createClient() {
        return {
          async run(options: RunOptions): Promise<RunState> {
            providerPrompt = options.prompt;
            return { output: { type: "lastMessage", value: "continued" } };
          },
        } as Pick<CodebuffClient, "run">;
      },
    });
    const parsed = parseRequest({
      model: "freebuff/base",
      stream: false,
      input: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: renderFreebuffAd(FREEBUFF_HOUSE_AD) }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue the task." }],
        },
      ],
    });

    await adapter.runTurn(parsed, { headers: new Headers() }, () => {});

    expect(providerPrompt).toContain("Continue the task.");
    expect(providerPrompt).not.toContain(FREEBUFF_AD_MARKER);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff derives a trusted workspace and sandbox from Codex turn metadata", () => {
  const cwd = process.cwd();
  const environment = `<environment_context>
<environments><environment primary="true"><cwd>${cwd}</cwd></environment></environments>
<workspace_roots><root>${cwd}</root></workspace_roots>
<sandbox_mode>workspace-write</sandbox_mode>
</environment_context>`;
  const parsed = parseRequest({
    model: "freebuff/base",
    stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-1" }) },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the workspace." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    ],
  });

  expect(extractFreebuffTurnEnvironment(parsed)).toEqual({ cwd, sandbox: "workspaceWrite" });
});

test("Freebuff read-only mode denies every SDK write or shell tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-readonly-"));
  try {
    const config = defaultConfig("browser-only");
    config.freebuff = { apiKey: "cb-test-key", credentialsPath: join(root, "not-logged-in.json"), cwd: root };
    const provider = providerConfig(config);
    let clientOptions: CodebuffClientOptions | undefined;
    const adapter = createFreebuffAdapter(provider, {
      ensureSession: async () => testSession(),
      createClient(options) {
        clientOptions = options;
        return {
          async run(): Promise<RunState> {
            return { output: { type: "structuredOutput", value: { ok: true } } };
          },
        } as Pick<CodebuffClient, "run">;
      },
    });

    await adapter.runTurn(parsedRequest(), { headers: new Headers() }, () => {});

    expect(clientOptions?.overrideTools).toBeDefined();
    for (const name of ["write_file", "str_replace", "apply_patch", "run_terminal_command", "run_file_change_hooks"] as const) {
      const result = await clientOptions!.overrideTools![name]!({} as never);
      expect(result).toEqual([{ type: "json", value: { errorMessage: expect.stringContaining("read-only") } }]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff cancellation produces a terminal incomplete event and releases the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-cancel-"));
  try {
    const config = defaultConfig("full");
    config.freebuff = { apiKey: "cb-test-key", credentialsPath: join(root, "not-logged-in.json"), cwd: root };
    const provider = providerConfig(config);
    const adapter = createFreebuffAdapter(provider, {
      ensureSession: async () => testSession(),
      createClient() {
        return {
          async run(options: RunOptions): Promise<RunState> {
            await new Promise<void>(resolve => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
            return { output: { type: "error", message: "cancelled" } };
          },
        } as Pick<CodebuffClient, "run">;
      },
    });
    const abort = new AbortController();
    const events: AdapterEvent[] = [];
    const run = adapter.runTurn(parsedRequest(), { headers: new Headers(), abortSignal: abort.signal }, event => events.push(event));
    abort.abort(new Error("test cancellation"));
    await run;

    expect(events).toContainEqual(expect.objectContaining({ type: "incomplete", reason: "cancelled" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Responses routes the Freebuff model to the SDK adapter", async () => {
  const config = defaultConfig("full");
  let adapterProvider: ReturnType<typeof providerConfig> | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "freebuff/base",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hello" }] }],
    }),
  }), config, provider => {
    adapterProvider = provider;
    return {
      name: "freebuff-test-adapter",
      async runTurn(_parsed, _incoming, emit) {
        emit({ type: "text_delta", text: "Hello from Freebuff.", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
  });

  expect(response.status).toBe(200);
  expect(adapterProvider?.adapter).toBe("freebuff");
  expect(adapterProvider?.freebuff?.agent).toBe("base3-free-deepseek-flash");
  const body = await response.json() as { model: string; output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(body.model).toBe("freebuff/base");
  expect(body.output.some(item => item.content?.some(part => part.text === "Hello from Freebuff."))).toBe(true);
});

test("Freebuff Codex integration does not manage ChatGPT voice routing", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    'experimental_realtime_webrtc_call_base_url = "https://voice.example/v1" # external owner',
    "",
  ].join("\n");
  const installed = installRoute(
    original,
    "http://127.0.0.1:17841/v1",
    true,
    true,
    false,
  );

  expect(installed.text).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
  expect(installed.text).toContain('experimental_realtime_webrtc_call_base_url = "https://voice.example/v1" # external owner');
  expect(installed.text).not.toContain("chatgpt.com/backend-api/codex");
  expect(installed.text).toContain(FREEBUFF_MANAGED_ROUTE_COMMENT);
  expect(installed.previousRealtimeWebrtcCallBaseUrl).toEqual({ present: false });
});

test("Freebuff integrates with a CC Switch custom provider without touching its account state", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-custom-provider-"));
  const previousCodexHome = process.env.CODEX_HOME;
  const previousAppHome = process.env.CODEX_FREEBUFF_WEB_HOME;
  try {
    const codexHome = join(root, "codex");
    const appHome = join(root, "app");
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_FREEBUFF_WEB_HOME = appHome;
    mkdirSync(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-luna"',
      'model_provider = "custom"',
      "",
      "[model_providers.custom]",
      'name = "OpenAI"',
      'wire_api = "responses"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        supported_in_api: true,
        tool_mode: "code_mode_only",
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      }],
    }));

    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    const journal = installCodexIntegration(config);
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('model_provider = "custom"');
    expect(installed).toContain('base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain(`model_catalog_json = ${JSON.stringify(getCodexManagedModelCatalogPath())}`);
    expect(journal.installed.provider_base_url).toEqual({
      provider: "custom",
      url: "http://127.0.0.1:17841/v1",
    });
    expect(journal.installed.model_catalog_json).toBe(getCodexManagedModelCatalogPath());
    expect(JSON.parse(readFileSync(getCodexManagedModelCatalogPath(), "utf8"))).toMatchObject({
      models: expect.arrayContaining([expect.objectContaining({ slug: "freebuff/base" })]),
    });

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(getCodexManagedModelCatalogPath())).toBe(false);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousAppHome === undefined) delete process.env.CODEX_FREEBUFF_WEB_HOME;
    else process.env.CODEX_FREEBUFF_WEB_HOME = previousAppHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff setup migrates an explicit retired provider marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-config-migration-"));
  const previousHome = process.env.CODEX_FREEBUFF_WEB_HOME;
  try {
    process.env.CODEX_FREEBUFF_WEB_HOME = root;
    const legacy = { ...defaultConfig("full"), provider: "chatgpt-web" } as unknown as Record<string, unknown>;
    writeFileSync(join(root, "config.json"), `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    expect(loadConfigForSetup().provider).toBe("freebuff");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_FREEBUFF_WEB_HOME;
    else process.env.CODEX_FREEBUFF_WEB_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff auth prefers the official CLI credentials file over API-key fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-auth-"));
  const credentialsPath = join(root, "credentials.json");
  try {
    writeFileSync(credentialsPath, JSON.stringify({
      default: { name: "Test user", email: "test@example.com", authToken: "official-session-token" },
    }), { mode: 0o600 });

    expect(resolveFreebuffAuth({ credentialsPath, apiKey: "legacy-key" })).toEqual({
      token: "official-session-token",
      source: "official-cli",
      credentialsPath,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff reports the manual login step instead of asking for an API key", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-freebuff-no-login-"));
  const previousApiKey = process.env.CODEBUFF_API_KEY;
  try {
    delete process.env.CODEBUFF_API_KEY;
    const config = defaultConfig("full");
    config.freebuff = { credentialsPath: join(root, "not-logged-in.json"), cwd: root };
    const events: AdapterEvent[] = [];
    await createFreebuffAdapter(providerConfig(config)).runTurn(
      parsedRequest(),
      { headers: new Headers() },
      event => events.push(event),
    );

    const finalEvent = events.at(-1);
    expect(finalEvent?.type).toBe("error");
    if (finalEvent?.type !== "error") throw new Error("expected a Freebuff error event");
    expect(finalEvent.message.includes("codex-freebuff-web login")).toBe(true);
    expect(finalEvent.message.includes("freebuff.com/chat")).toBe(true);
  } finally {
    if (previousApiKey === undefined) delete process.env.CODEBUFF_API_KEY;
    else process.env.CODEBUFF_API_KEY = previousApiKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Freebuff session admission uses the official bearer and model headers", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const manager = new FreebuffSessionManager({
    baseUrl: "https://codebuff.com",
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({
        status: "active",
        instanceId: "official-instance",
        model: "deepseek/deepseek-v4-flash",
        admittedAt: "2026-09-04T00:00:00.000Z",
        expiresAt: "2026-09-04T01:00:00.000Z",
        remainingMs: 3_600_000,
      });
    }) as typeof fetch,
  });

  await expect(manager.ensure("official-session-token", "deepseek/deepseek-v4-flash")).resolves.toMatchObject({
    instanceId: "official-instance",
  });
  expect(request?.url).toBe("https://codebuff.com/api/v1/freebuff/session");
  expect(request?.init?.method).toBe("POST");
  expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer official-session-token");
  expect(new Headers(request?.init?.headers).get("x-freebuff-model")).toBe("deepseek/deepseek-v4-flash");
});
