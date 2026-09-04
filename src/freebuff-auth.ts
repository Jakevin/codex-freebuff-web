import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The path used by the official Freebuff CLI for its browser-login credentials. */
export const OFFICIAL_FREEBUFF_CREDENTIALS_PATH = join(homedir(), ".config", "manicode", "credentials.json");

export type FreebuffAuthSource = "official-cli" | "legacy-api-key" | null;

export interface FreebuffAuth {
  /** This is the official CLI's saved bearer token, not a user-entered API key. */
  token?: string;
  source: FreebuffAuthSource;
  credentialsPath: string;
}

export interface FreebuffAuthOptions {
  credentialsPath?: string;
  /** Compatibility fallback for older API-key configurations. */
  apiKey?: string;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function resolveFreebuffCredentialsPath(value?: string): string {
  const configured = value?.trim()
    || process.env.FREEBUFF_CREDENTIALS_PATH?.trim()
    || process.env.CODEBUFF_CREDENTIALS_PATH?.trim();
  const path = expandHome(configured || OFFICIAL_FREEBUFF_CREDENTIALS_PATH);
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

function readOfficialCliToken(credentialsPath: string): string | undefined {
  if (!existsSync(credentialsPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const profile = (parsed as Record<string, unknown>).default;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return undefined;
    const token = (profile as Record<string, unknown>).authToken;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    // A malformed or partially-written credentials file is equivalent to not being logged in.
    // Never print the file contents: it may contain a bearer token.
    return undefined;
  }
}

/** Resolve official CLI credentials first, with the old API-key path as an explicit fallback. */
export function resolveFreebuffAuth(options: FreebuffAuthOptions = {}): FreebuffAuth {
  const credentialsPath = resolveFreebuffCredentialsPath(options.credentialsPath);
  const officialToken = readOfficialCliToken(credentialsPath);
  if (officialToken) {
    return { token: officialToken, source: "official-cli", credentialsPath };
  }

  const legacyApiKey = options.apiKey?.trim() || process.env.CODEBUFF_API_KEY?.trim();
  return legacyApiKey
    ? { token: legacyApiKey, source: "legacy-api-key", credentialsPath }
    : { source: null, credentialsPath };
}

export function freebuffLoginRequiredMessage(credentialsPath: string): string {
  return "No Freebuff login found. Run `codex-freebuff-web login`, finish the browser login, and retry. "
    + `The bridge stores an official-compatible session at ${credentialsPath}. `
    + "For the separate Web Chat, open https://freebuff.com/chat.";
}
