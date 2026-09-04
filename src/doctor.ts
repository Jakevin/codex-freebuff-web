import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig } from "./config";
import { inspectCodexIntegration } from "./codex-integration";
import { getServiceStatus } from "./service";
import { resolveFreebuffAuth } from "./freebuff-auth";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-freebuff-web" || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    if (body.accepting_turns !== true) {
      return { id: "proxy", status: "error", message: "Responses proxy is drained and is not accepting Codex turns" };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    return {
      id: "proxy",
      status: "error",
      message: "Responses proxy is not reachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({
      id: "config",
      status: "error",
      message: "Configuration is invalid",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, checks };
  }

  const auth = resolveFreebuffAuth({
    credentialsPath: config.freebuff?.credentialsPath,
    apiKey: config.freebuff?.apiKey,
  });
  checks.push(auth.source === "official-cli"
    ? { id: "freebuff-login", status: "ok", message: "Official-compatible Freebuff login was found" }
    : auth.source === "legacy-api-key"
      ? { id: "freebuff-login", status: "warning", message: "A legacy CODEBUFF_API_KEY fallback is configured; browser login is recommended" }
      : {
          id: "freebuff-login",
          status: "error",
          message: "Freebuff is not logged in; run `codex-freebuff-web login` and finish the browser login",
          detail: `Credentials are read from ${auth.credentialsPath}`,
        });

  const cwd = config.freebuff?.cwd;
  if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) {
    checks.push({ id: "workspace", status: "error", message: `Freebuff working directory is not a directory: ${cwd}` });
  } else {
    checks.push({ id: "workspace", status: "ok", message: cwd ? `Freebuff working directory: ${cwd}` : "Freebuff uses the trusted Codex working directory" });
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({ id: "codex", status: "error", message: "Codex Freebuff model route is not installed" });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex integration is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex Freebuff model route is installed" });
  }

  const service = getServiceStatus();
  checks.push(!service.supported
    ? { id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" }
    : service.loaded
      ? { id: "service", status: "ok", message: "macOS Freebuff background service is loaded" }
      : service.installed
        ? { id: "service", status: "warning", message: "macOS Freebuff background service is installed but not loaded", detail: JSON.stringify(service) }
        : { id: "service", status: "warning", message: "Freebuff background service is not installed; keep `serve` running manually" });

  checks.push(await proxyCheck(config));
  checks.push({
    id: "tools",
    status: "ok",
    message: config.mode === "full"
      ? "Freebuff local coding tools are enabled with workspace-write access"
      : "Freebuff local coding tools are restricted to read-only access",
  });

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
