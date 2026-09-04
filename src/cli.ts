#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync, rmSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  inspectCodexIntegration,
  readCodexSubagentProtocol,
  setCodexSubagentProtocol,
  uninstallCodexIntegration,
} from "./codex-integration";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runCommand } from "./process";
import { startServer } from "./server";
import { runOfficialFreebuffCli } from "./freebuff-cli";
import { runFreebuffLogin } from "./freebuff-login";
import { assertServiceIdle, cancelActiveTurns, getServiceStatus, installService, restartService, startService, stopService, uninstallService } from "./service";
import { preflightSetup, setup, type SetupOptions } from "./setup";
import { VERSION } from "./version";

const HELP = `codex-freebuff-web ${VERSION}

Focused Codebuff-backed models for the native Codex harness.

Usage:
  codex-freebuff-web setup [--full|--read-only] [options]
  codex-freebuff-web doctor [--json]
  codex-freebuff-web route <status|connect|disconnect>
  codex-freebuff-web subagents <status|compatibility-v1|native>
  codex-freebuff-web serve
  codex-freebuff-web service <status|install|start|restart|stop|cancel-turns>
  codex-freebuff-web login [--credentials-path PATH] [--no-open]
  codex-freebuff-web freebuff [official CLI arguments...] (optional)
  codex-freebuff-web webchat
  codex-freebuff-web open <cli|chat>
  codex-freebuff-web uninstall [--yes] [--keep-data]

Setup options:
  --freebuff                   Use the official Freebuff CLI/backend (the default and only provider)
  --read-only                  Read-only Freebuff run
  --browser-only               Deprecated alias for --read-only
  --full                       Workspace-write Freebuff run (default)
  --api-key KEY                Legacy fallback; normal setup uses built-in browser login with no API key
  --agent ID                   Freebuff agent id (default: base3-free-deepseek-flash)
  --max-agent-steps NUMBER     Safety ceiling for one Freebuff run (default: 20)
  --cwd PATH                  Explicit absolute working directory for the agent
  --credentials-path PATH      Official CLI credentials.json path (default: ~/.config/manicode/credentials.json)
  --freebuff-cli-path PATH     Optional official Freebuff CLI executable for the freebuff command
  --port NUMBER                Loopback Responses port (default: 17841)
  --replace-codex-route        Reversibly replace existing Responses or Voice route settings
  --subagent-protocol MODE     compatibility-v1 (default) or native (advanced)
  --restart-service            Explicitly restart this project's daemon after an update

Global:
  --home PATH                  Override ~/.codex-freebuff-web
  -h, --help
  -v, --version
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

async function loginCommand(args: string[]): Promise<void> {
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  const credentialsPath = takeOption(args, "--credentials-path") ?? config?.freebuff?.credentialsPath;
  const noOpen = takeFlag(args, "--no-open");
  assertNoArgs(args);
  const result = await runFreebuffLogin({
    credentialsPath,
    autoOpen: !noOpen,
    onMessage: message => stdout.write(`${message}\n`),
  });
  stdout.write(`Logged in to Freebuff as ${result.user.name} (${result.user.email}).\n`);
  stdout.write(`Credentials saved to ${result.credentialsPath}\n`);
}

async function freebuffCommand(args: string[]): Promise<void> {
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  const status = runOfficialFreebuffCli(args, config?.freebuff?.cliPath);
  if (status !== 0) process.exitCode = status || 1;
}

async function setupCommand(args: string[]): Promise<void> {
  const preflightOnly = takeFlag(args, "--preflight-only");
  const readOnly = takeFlag(args, "--read-only");
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if ((readOnly && browserOnly) || ((readOnly || browserOnly) && full)) {
    throw new Error("Choose one setup mode: --read-only or --full");
  }
  takeFlag(args, "--freebuff");
  const portRaw = takeOption(args, "--port");
  const apiKey = takeOption(args, "--api-key");
  const credentialsPath = takeOption(args, "--credentials-path");
  const freebuffCliPath = takeOption(args, "--freebuff-cli-path");
  const agent = takeOption(args, "--agent");
  const maxAgentStepsRaw = takeOption(args, "--max-agent-steps");
  const cwd = takeOption(args, "--cwd");
  const options: SetupOptions = {
    provider: "freebuff",
    mode: readOnly || browserOnly ? "browser-only" : "full",
    ...(portRaw ? { port: Number(portRaw) } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(credentialsPath ? { credentialsPath } : {}),
    ...(freebuffCliPath ? { freebuffCliPath } : {}),
    ...(agent ? { agent } : {}),
    ...(maxAgentStepsRaw ? { maxAgentSteps: Number(maxAgentStepsRaw) } : {}),
    ...(cwd ? { cwd } : {}),
  };
  const subagentProtocol = takeOption(args, "--subagent-protocol");
  if (subagentProtocol !== undefined) {
    if (subagentProtocol !== "compatibility-v1" && subagentProtocol !== "native") {
      throw new Error("--subagent-protocol must be compatibility-v1 or native");
    }
    options.subagentProtocol = subagentProtocol;
  }
  for (const removedFlag of [
    "--automatic-browser-interaction",
    "--zero-risk-browser-interaction",
    "--refresh-account-capabilities",
    "--login",
    "--auto-approve-tool-calls",
    "--bigger-context",
    "--standard-context",
    "--zero-risk-pro",
    "--zero-risk-default",
  ]) {
    if (takeFlag(args, removedFlag)) throw new Error(`${removedFlag} is a removed ChatGPT Web option; configure Freebuff instead`);
  }
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.restartService = takeFlag(args, "--restart-service");
  takeFlag(args, "--acknowledge-unofficial");
  assertNoArgs(args);

  if (preflightOnly) {
    preflightSetup(options);
    stdout.write("Setup preflight complete.\n");
    return;
  }

  const result = await setup(options);
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  stdout.write("No API key was stored. Before the first Codex task, run `codex-freebuff-web login` and finish the browser login.\n");
  stdout.write("Restart the Codex app once so it loads the managed Freebuff model catalog.\n");
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function routeCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const result = action === "status"
    ? (() => {
        const status = inspectCodexIntegration();
        return {
          installed: status.installed,
          active: status.active,
          ...(status.routeUrl ? { routeUrl: status.routeUrl } : {}),
          errors: status.errors,
        };
      })()
    : action === "connect"
      ? activateCodexIntegration()
      : action === "disconnect"
        ? deactivateCodexIntegration()
        : undefined;
  if (!result) throw new Error(`Unknown route action: ${action}`);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function subagentsCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = loadConfig();
  if (config.purpose === "dev-harness") {
    throw new Error("The isolated DEV harness has no Codex subagent protocol to configure");
  }
  if (action === "status") {
    const integration = inspectCodexIntegration();
    stdout.write(`${JSON.stringify({
      protocol: readCodexSubagentProtocol(config.subagentProtocol),
      installed: integration.installed,
      active: integration.active,
    }, null, 2)}\n`);
    return;
  }
  if (action !== "compatibility-v1" && action !== "native") {
    throw new Error("Subagent protocol must be one of: status, compatibility-v1, native");
  }
  const journal = setCodexSubagentProtocol(config, action);
  stdout.write(`${JSON.stringify({
    protocol: journal.installed.subagent_protocol,
    codexRestartRequired: true,
    launcherRestartRequired: true,
  }, null, 2)}\n`);
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = action === "status" ? undefined : loadConfig();
  if (action === "cancel-turns") {
    stdout.write(`${JSON.stringify(await cancelActiveTurns(config!), null, 2)}\n`);
    return;
  }
  const status = action === "status" ? getServiceStatus()
    : action === "install" ? installService(config!)
      : action === "start" ? startService()
        : action === "restart" ? await restartService(config!)
          : action === "stop" ? await stopService(config!)
            : undefined;
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function tunnelCommand(args: string[]): Promise<void> {
  assertNoArgs(args);
  throw new Error("OpenAI tunnel commands have been removed; Codebuff connects through its SDK.");
}

async function openCommand(args: string[]): Promise<void> {
  const target = args.shift();
  assertNoArgs(args);
  const urls: Record<string, string> = {
    cli: "https://freebuff.com/cli",
    chat: "https://freebuff.com/chat",
    webchat: "https://freebuff.com/chat",
  };
  const url = target ? urls[target] : undefined;
  if (!url) throw new Error("Choose one of: cli, chat");
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else {
    stdout.write(`${url}\n`);
  }
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  assertNoArgs(args);
  if (!yes && !await confirm("Restore Codex config, stop services, and remove this installation?")) {
    throw new Error("Uninstall cancelled");
  }
  const config = existsSync(getConfigPath()) ? loadConfig() : undefined;
  if (!config && process.platform === "darwin" && getServiceStatus().installed) {
    throw new Error("Service exists but configuration is missing; refusing an unverifiable uninstall");
  }
  if (config && process.platform === "darwin") await assertServiceIdle(config);
  if (config && process.platform === "darwin") await uninstallService(config);
  uninstallCodexIntegration();
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
  stdout.write(keepData ? "Uninstalled; private application data was preserved.\n" : "Uninstalled and removed private application data.\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_FREEBUFF_WEB_HOME = home;
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "help") stdout.write(HELP);
  else if (command === "setup") await setupCommand(args);
  else if (command === "login") await loginCommand(args);
  else if (command === "freebuff" || command === "cli") await freebuffCommand(args);
  else if (command === "webchat") {
    args.unshift("chat");
    await openCommand(args);
  }
  else if (command === "doctor" || command === "status") await doctorCommand(args);
  else if (command === "route") await routeCommand(args);
  else if (command === "subagents") await subagentsCommand(args);
  else if (command === "browser") {
    assertNoArgs(args);
    throw new Error("Browser commands have been removed; this runtime uses the Codebuff SDK.");
  } else if (command === "serve") {
    assertNoArgs(args);
    const config = loadConfig();
    const server = startServer(config);
    stdout.write(`codex-freebuff-web ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`);
    await new Promise<void>(() => {});
  } else if (command === "dev") {
    throw new Error("The ChatGPT Web DEV harness has been removed; run a Freebuff Responses task instead.");
  }
  else if (command === "mcp") {
    assertNoArgs(args);
    throw new Error("The ChatGPT MCP bridge has been removed; Codebuff runs its local tools through the SDK.");
  }
  else if (command === "service") await serviceCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "open") await openCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`codex-freebuff-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
