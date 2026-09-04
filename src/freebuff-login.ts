import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus, hostname, networkInterfaces } from "node:os";
import { atomicWriteFile } from "./config";
import { resolveFreebuffCredentialsPath } from "./freebuff-auth";
import { runCommand } from "./process";

/** The production Freebuff website used by the official CLI device-login flow. */
export const FREEBUFF_LOGIN_WEB_URL = "https://freebuff.com";

const LOGIN_REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_POLL_TIMEOUT_MS = 5 * 60_000;

export interface FreebuffLoginUser {
  id?: string;
  name: string;
  email: string;
  authToken: string;
  fingerprintId?: string;
  fingerprintHash?: string;
  credits?: number;
}

export interface FreebuffLoginResult {
  user: FreebuffLoginUser;
  credentialsPath: string;
  loginUrl: string;
  fingerprintId: string;
  attempts: number;
  browserOpened: boolean;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface FreebuffLoginOptions {
  credentialsPath?: string;
  /** Test/development override; production defaults to the official Freebuff website. */
  baseUrl?: string;
  /** Use the native browser opener on supported platforms. Defaults to true on macOS. */
  autoOpen?: boolean;
  /** Injected for tests or callers that own browser launching. */
  openUrl?: (url: string) => void;
  /** Injected for tests; production uses the global fetch implementation. */
  fetch?: FetchLike;
  /** Injected for tests or cancellation-aware callers. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Injected for deterministic tests. */
  now?: () => number;
  /** Override the official five-minute polling window. */
  timeoutMs?: number;
  /** Override the official polling interval. */
  intervalMs?: number;
  /** Optional progress sink; login URLs are intentionally printed by the CLI caller. */
  onMessage?: (message: string) => void;
  /** Override the device fingerprint only for controlled integrations/tests. */
  fingerprintId?: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  detail?: string;
}

function trimBaseUrl(value?: string): string {
  return (value?.trim() || process.env.FREEBUFF_WEB_URL?.trim() || FREEBUFF_LOGIN_WEB_URL).replace(/\/+$/, "");
}

/**
 * Generate a stable, local-only device identifier without adding another runtime dependency.
 * The official CLI also sends a deterministic enhanced fingerprint to the same login endpoints.
 */
export function createFreebuffFingerprintId(): string {
  const macAddresses = Object.values(networkInterfaces())
    .flatMap(interfaces => interfaces ?? [])
    .filter(networkInterface => networkInterface
      && !networkInterface.internal
      && networkInterface.mac
      && networkInterface.mac !== "00:00:00:00:00:00")
    .map(networkInterface => networkInterface!.mac)
    .sort();
  const fingerprintInput = JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    cpus: cpus().map(cpu => ({ model: cpu.model, speed: cpu.speed })),
    macAddresses,
  });
  return `enhanced-${createHash("sha256").update(fingerprintInput).digest("base64url")}`;
}

function responseDetail(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return undefined;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGIN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.text();
    let data: unknown;
    if (body.trim()) {
      try {
        data = JSON.parse(body);
      } catch {
        data = undefined;
      }
    }
    const detail = responseDetail(data);
    return {
      ok: response.ok,
      status: response.status,
      ...(data === undefined ? {} : { data }),
      ...(detail ? { detail } : {}),
    };
  } catch (error) {
    throw new Error(`Could not reach the Freebuff login service: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function requireLoginCode(data: unknown): { loginUrl: string; fingerprintHash: string; expiresAt: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Freebuff returned an invalid login response");
  }
  const record = data as Record<string, unknown>;
  const loginUrl = typeof record.loginUrl === "string" ? record.loginUrl.trim() : "";
  const fingerprintHash = typeof record.fingerprintHash === "string" ? record.fingerprintHash.trim() : "";
  const expiresAt = typeof record.expiresAt === "string"
    ? record.expiresAt.trim()
    : typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
      ? String(record.expiresAt)
      : "";
  if (!loginUrl || !fingerprintHash || !expiresAt) {
    throw new Error("Freebuff returned an incomplete login response");
  }
  return { loginUrl, fingerprintHash, expiresAt };
}

function requireUser(data: unknown, fingerprintId: string, fingerprintHash: string): FreebuffLoginUser | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const candidate = (data as Record<string, unknown>).user;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const authToken = typeof record.authToken === "string" ? record.authToken.trim() : "";
  if (!name || !email || !authToken) {
    throw new Error("Freebuff returned incomplete account credentials");
  }
  return {
    ...(typeof record.id === "string" && record.id.trim() ? { id: record.id.trim() } : {}),
    name,
    email,
    authToken,
    fingerprintId: typeof record.fingerprintId === "string" && record.fingerprintId.trim()
      ? record.fingerprintId.trim()
      : fingerprintId,
    fingerprintHash: typeof record.fingerprintHash === "string" && record.fingerprintHash.trim()
      ? record.fingerprintHash.trim()
      : fingerprintHash,
    ...(typeof record.credits === "number" ? { credits: record.credits } : {}),
  };
}

function readCredentialContainer(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Write the same default-profile format consumed by the official Freebuff CLI. */
export function saveFreebuffCredentials(path: string, user: FreebuffLoginUser): void {
  const credentials = { ...readCredentialContainer(path), default: user };
  atomicWriteFile(path, `${JSON.stringify(credentials, null, 2)}\n`);
}

export function openFreebuffLoginUrl(url: string): void {
  if (process.platform === "darwin") {
    const result = runCommand("open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
    return;
  }
  if (process.platform === "win32") {
    const result = runCommand("cmd", ["/c", "start", "", url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
    return;
  }
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    const result = runCommand("xdg-open", [url]);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  }
}

export async function runFreebuffLogin(options: FreebuffLoginOptions = {}): Promise<FreebuffLoginResult> {
  const baseUrl = trimBaseUrl(options.baseUrl);
  const credentialsPath = resolveFreebuffCredentialsPath(options.credentialsPath);
  const fingerprintId = options.fingerprintId?.trim() || createFreebuffFingerprintId();
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? LOGIN_POLL_TIMEOUT_MS;
  const onMessage = options.onMessage ?? (() => {});

  const loginCode = await requestJson(fetchImpl, `${baseUrl}/api/auth/cli/code`, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
  });
  if (!loginCode.ok) {
    throw new Error(`Freebuff could not create a login session (HTTP ${loginCode.status})${loginCode.detail ? `: ${loginCode.detail}` : ""}`);
  }
  const { loginUrl, fingerprintHash, expiresAt } = requireLoginCode(loginCode.data);

  onMessage("Open this Freebuff login URL in your browser:");
  onMessage(loginUrl);
  let browserOpened = false;
  if (options.autoOpen ?? process.platform === "darwin") {
    try {
      (options.openUrl ?? openFreebuffLoginUrl)(loginUrl);
      browserOpened = true;
      onMessage("The browser was opened. Finish the login there; this terminal will wait for completion.");
    } catch (error) {
      onMessage(`Could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
      onMessage("Open the URL above manually; this terminal will still wait for completion.");
    }
  } else {
    onMessage("Open the URL above manually; this terminal will wait for completion.");
  }

  const deadline = now() + timeoutMs;
  let attempts = 0;
  while (now() < deadline) {
    attempts += 1;
    try {
      const query = new URLSearchParams({ fingerprintId, fingerprintHash, expiresAt });
      const status = await requestJson(fetchImpl, `${baseUrl}/api/auth/cli/status?${query.toString()}`, {
        method: "GET",
        headers: { "accept": "application/json" },
      });
      if (status.ok) {
        const user = requireUser(status.data, fingerprintId, fingerprintHash);
        if (user) {
          saveFreebuffCredentials(credentialsPath, user);
          return { user, credentialsPath, loginUrl, fingerprintId, attempts, browserOpened };
        }
      }
    } catch (error) {
      // Match the official CLI: transient status/network failures keep polling until expiry.
      if (attempts === 1) onMessage(`Waiting for Freebuff login: ${error instanceof Error ? error.message : String(error)}`);
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error("Freebuff login timed out. Run `codex-freebuff-web login` again and finish the browser login.");
}
