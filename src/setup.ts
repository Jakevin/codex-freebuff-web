import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import type { AppConfig, BrowserInteractionMode, RuntimeMode, SubagentProtocol } from "./config";
import {
  currentRuntimeCommand,
  defaultConfig,
  expandUserPath,
  getConfigPath,
  loadConfigForSetup,
  saveConfig,
} from "./config";
import {
  installCodexIntegration,
  preflightCodexIntegration,
} from "./codex-integration";
import {
  assertServiceIdle,
  getServiceStatus,
  installService,
  restartService,
} from "./service";
import { VERSION } from "./version";
import { FREEBUFF_AGENT, FREEBUFF_MODEL_ID } from "./freebuff-models";

/**
 * The public setup shape keeps the old option names for callers upgrading from the browser
 * release. Only the Freebuff fields are consumed by the active setup path.
 */
export interface SetupOptions {
  mode: RuntimeMode;
  provider?: "freebuff";
  /** Legacy compatibility only; official setup uses the built-in browser login. */
  apiKey?: string;
  credentialsPath?: string;
  freebuffCliPath?: string;
  agent?: string;
  maxAgentSteps?: number;
  cwd?: string;
  browserInteractionMode?: BrowserInteractionMode;
  subagentProtocol?: SubagentProtocol;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
  appName?: string;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  experimentalBiggerContext?: boolean;
  zeroRiskProEnabled?: boolean;
  replaceCodexRoute?: boolean;
  restartService?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: RuntimeMode;
  configPath: string;
  loginCreated: boolean;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  codexRestartRequired: true;
  connectorSetupRequired: boolean;
}

export interface DevProfileSetupResult {
  mode: RuntimeMode;
  configPath: string;
  tunnelReady: boolean | null;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

/** Compatibility helper retained for old callers; Freebuff does not probe browser capabilities. */
export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): boolean {
  if (interactionMode === "manual") return false;
  return refreshAccountCapabilities
    || existing?.browserInteractionMode === "manual"
    || existing?.browserHost !== "launcher"
    || typeof existing?.solAvailable !== "boolean"
    || typeof existing?.proAvailable !== "boolean";
}

/** Compatibility helper retained for migration diagnostics; Freebuff creates no tunnel. */
export function existingFullSetupCredentials(
  existing: AppConfig | undefined,
  _interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): ExistingFullSetupCredentials {
  return {
    tunnelId: Boolean(existing?.mode === "full" && existing.tunnel?.tunnelId),
    runtimeKey: Boolean(existing?.mode === "full" && existing.tunnel?.runtimeKeyFile && existsSync(existing.tunnel.runtimeKeyFile)),
  };
}

/** Compatibility helper retained for callers that still compare legacy runtime fields. */
export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.provider !== after.provider
    || before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath
    || before.browserInteractionMode !== after.browserInteractionMode
    || JSON.stringify(before.tunnel) !== JSON.stringify(after.tunnel);
}

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === "codex-freebuff-web"
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectAvailable(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? rejectAvailable(error) : resolveAvailable()));
  });
}

async function waitForProxy(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (setupProxyIsReady(body, config)) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Responses proxy did not become ready: ${lastError}`);
}

function validateAgentOptions(options: SetupOptions): void {
  if (options.maxAgentSteps !== undefined
    && (!Number.isSafeInteger(options.maxAgentSteps) || options.maxAgentSteps < 1 || options.maxAgentSteps > 1_000)) {
    throw new Error("--max-agent-steps must be an integer from 1 to 1000");
  }
  if (options.cwd !== undefined && !isAbsolute(options.cwd)) {
    throw new Error("--cwd must be an absolute path");
  }
  if (options.credentialsPath !== undefined && !isAbsolute(expandUserPath(options.credentialsPath))) {
    throw new Error("--credentials-path must be an absolute path");
  }
}

function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

function baseConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  validateAgentOptions(options);
  const config = existing ? structuredClone(existing) : defaultConfig(options.mode);
  config.provider = "freebuff";
  config.mode = options.mode;
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    config.port = options.port;
  }
  const configuredAgent = options.agent?.trim() || config.freebuff?.agent?.trim();
  config.freebuff = {
    ...(config.freebuff ?? {}),
    model: config.freebuff?.model?.trim() || FREEBUFF_MODEL_ID,
    agent: !configuredAgent || configuredAgent === "codebuff/base2@latest" ? FREEBUFF_AGENT : configuredAgent,
    ...(options.apiKey ? { apiKey: options.apiKey.trim() } : {}),
    ...(options.credentialsPath ? { credentialsPath: expandUserPath(options.credentialsPath) } : {}),
    ...(options.freebuffCliPath ? { cliPath: options.freebuffCliPath.trim() } : {}),
    ...(options.agent ? { agent: options.agent.trim() } : {}),
    ...(options.maxAgentSteps !== undefined ? { maxAgentSteps: options.maxAgentSteps } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  if (options.subagentProtocol) config.subagentProtocol = options.subagentProtocol;

  // These fields belong to the retired ChatGPT Web transport. Remove their authority from the
  // persisted Freebuff configuration while leaving the structural fields for old type callers.
  delete config.tunnel;
  delete config.automaticTunnel;
  delete config.manualTunnel;
  delete config.browserHostDescriptorPath;
  config.browserHost = "managed-chrome";
  config.browserInteractionMode = "automatic";
  return config;
}

export function preflightSetup(options: SetupOptions): void {
  const existing = loadExistingConfig();
  if (existing?.purpose === "dev-harness") {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = baseConfig(existing, options);
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
}

async function setupFreebuff(
  existing: AppConfig | undefined,
  config: AppConfig,
  options: SetupOptions,
): Promise<SetupResult> {
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
  const beforeService = getServiceStatus();
  if (beforeService.loaded && !existing) {
    throw new Error("A codex-freebuff-web service is loaded but its configuration is missing; refusing to replace an unverifiable process");
  }
  const changedWhileLoaded = Boolean(existing && beforeService.loaded && JSON.stringify(existing) !== JSON.stringify(config));
  if (changedWhileLoaded && !options.restartService) {
    throw new Error(
      "The Freebuff daemon is currently serving a Codex task and setup would change its runtime. "
        + "Rerun with --restart-service after the active task finishes.",
    );
  }
  if (changedWhileLoaded && existing) await assertServiceIdle(existing);
  if (beforeService.supported && !beforeService.loaded) await assertPortAvailable(config.host, config.port);

  saveConfig(config);
  let serviceLoaded = false;
  if (beforeService.supported) {
    installService(config);
    if (changedWhileLoaded && options.restartService && existing) await restartService(existing);
    await waitForProxy(config);
    serviceLoaded = getServiceStatus().loaded;
  }
  installCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated: false,
    serviceLoaded,
    tunnelReady: null,
    codexRestartRequired: true,
    connectorSetupRequired: false,
  };
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const existing = loadExistingConfig();
  if (existing?.purpose === "dev-harness") {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = baseConfig(existing, options);
  return setupFreebuff(existing, config, options);
}

/** The isolated browser DEV harness is intentionally retired with the ChatGPT Web transport. */
export async function setupDevProfile(_options: SetupOptions): Promise<DevProfileSetupResult> {
  throw new Error("The ChatGPT Web DEV harness has been removed; Freebuff uses the native Responses route.");
}
