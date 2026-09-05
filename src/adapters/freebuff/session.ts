import { FREEBUFF_MODEL_ID } from "../../freebuff-models";

export const DEFAULT_FREEBUFF_APP_URL = "https://www.codebuff.com";
export const FREEBUFF_SESSION_ENDPOINT = "/api/v1/freebuff/session";
export const FREEBUFF_MODEL_HEADER = "x-freebuff-model";

export interface ActiveFreebuffSession {
  instanceId: string;
  model: string;
  admittedAt?: string;
  expiresAt?: string;
  remainingMs?: number;
}

export class FreebuffSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly responseCode?: string,
  ) {
    super(message);
    this.name = "FreebuffSessionError";
  }
}

export interface FreebuffSessionManagerOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Leave a small grace period so a run does not begin just as the session expires. */
  refreshBeforeMs?: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringField(body: JsonObject, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/$/, "") || DEFAULT_FREEBUFF_APP_URL;
}

function responseCode(body: JsonObject | undefined): string | undefined {
  const status = body && stringField(body, "status");
  return status;
}

function retryHint(body: JsonObject | undefined): string {
  const resetAt = body && stringField(body, "resetAt");
  if (resetAt) return ` The limit resets at ${resetAt}.`;
  const retryAfterMs = body?.retryAfterMs;
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return ` Retry after ${Math.ceil(retryAfterMs / 1_000)} seconds.`;
  }
  return "";
}

function sessionFailureMessage(body: JsonObject | undefined, statusCode: number): string {
  const status = responseCode(body);
  const retry = retryHint(body);
  if (statusCode === 401) {
    return "Freebuff login was rejected or expired. Run `codex-freebuff-web login`, finish the browser login, and retry.";
  }
  const supplied = body && stringField(body, "message");
  if (supplied) return `Freebuff session admission failed: ${supplied}${retry}`;
  switch (status) {
    case "country_blocked":
      return "Freebuff is not available in the current country or network.";
    case "model_locked":
      return "A different Freebuff model session is already active. End that session in the official Freebuff CLI, then retry.";
    case "model_unavailable":
      return "The selected Freebuff model is unavailable right now. Retry later or choose the model offered by the official CLI.";
    case "rate_limited":
    case "spend_limited":
    case "ip_capped":
      return `Freebuff has reached its current free-session limit.${retry || " Retry after the limit resets."}`;
    case "banned":
      return "This Freebuff account is not allowed to start a session.";
    default:
      return `Freebuff session admission failed with HTTP ${statusCode}.`;
  }
}

function activeSession(body: JsonObject | undefined, requestedModel: string): ActiveFreebuffSession {
  if (responseCode(body) !== "active") {
    throw new FreebuffSessionError(sessionFailureMessage(body, 200), 200, responseCode(body));
  }
  const instanceId = body && stringField(body, "instanceId");
  if (!instanceId) {
    throw new FreebuffSessionError("Freebuff returned an active session without an instance id.", 200, "invalid_response");
  }
  const model = body && stringField(body, "model");
  return {
    instanceId,
    model: model ?? requestedModel,
    ...(stringField(body!, "admittedAt") ? { admittedAt: stringField(body!, "admittedAt") } : {}),
    ...(stringField(body!, "expiresAt") ? { expiresAt: stringField(body!, "expiresAt") } : {}),
    ...(typeof body?.remainingMs === "number" ? { remainingMs: body.remainingMs } : {}),
  };
}

interface OwnedSession extends ActiveFreebuffSession {
  token: string;
}

/**
 * Small process-local Freebuff session owner.
 *
 * The official CLI admits one Freebuff session and reuses it for its turns. The bridge follows
 * the same rule: admission is shared across requests and the slot is released only at shutdown.
 */
export class FreebuffSessionManager {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshBeforeMs: number;
  // Freebuff allows only one active instance per account, even when the requested model changes.
  private readonly active = new Map<string, OwnedSession>();
  private readonly pending = new Map<string, Promise<ActiveFreebuffSession>>();

  constructor(options: FreebuffSessionManagerOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_FREEBUFF_APP_URL);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshBeforeMs = options.refreshBeforeMs ?? 15_000;
  }

  get endpoint(): string {
    return `${this.baseUrl}${FREEBUFF_SESSION_ENDPOINT}`;
  }

  async ensure(token: string, model = FREEBUFF_MODEL_ID, signal?: AbortSignal): Promise<ActiveFreebuffSession> {
    const authToken = token.trim();
    const requestedModel = model.trim() || FREEBUFF_MODEL_ID;
    if (!authToken) throw new FreebuffSessionError("Freebuff auth token is empty.", 401, "unauthorized");

    const key = authToken;
    for (;;) {
      const inFlight = this.pending.get(key);
      if (inFlight) {
        const admitted = await inFlight;
        if (admitted.model === requestedModel && !this.isExpired(admitted)) return admitted;
        continue;
      }

      const current = this.active.get(key);
      if (current && current.model === requestedModel && !this.isExpired(current)) return current;
      // Keep a valid session for the old model until the new admission succeeds. A rate-limited
      // model switch must not take a working session offline.
      if (current && this.isExpired(current)) this.active.delete(key);

      const admission = this.admit(authToken, requestedModel, signal);
      this.pending.set(key, admission);
      try {
        return await admission;
      } finally {
        if (this.pending.get(key) === admission) this.pending.delete(key);
      }
    }
  }

  invalidate(token: string, model?: string): void {
    const key = token.trim();
    const current = this.active.get(key);
    if (current && (!model || current.model === model.trim())) this.active.delete(key);
  }

  async releaseAll(): Promise<void> {
    const sessions = [...this.active.values()];
    this.active.clear();
    await Promise.allSettled(sessions.map(session => this.release(session)));
  }

  private isExpired(session: ActiveFreebuffSession): boolean {
    if (typeof session.expiresAt === "string") {
      const expiresAtMs = Date.parse(session.expiresAt);
      if (Number.isFinite(expiresAtMs)) return expiresAtMs <= this.now() + this.refreshBeforeMs;
    }
    if (typeof session.remainingMs === "number") return session.remainingMs <= this.refreshBeforeMs;
    // The official response normally includes an expiry. If an older response does not, keep the
    // admitted session; the upstream gate will provide the authoritative expiry/error.
    return false;
  }

  private async admit(token: string, model: string, signal?: AbortSignal): Promise<ActiveFreebuffSession> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          [FREEBUFF_MODEL_HEADER]: model,
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new FreebuffSessionError(
        `Could not reach the Freebuff session service: ${error instanceof Error ? error.message : String(error)}`,
        503,
        "network_error",
      );
    }

    const body = object(await response.json().catch(() => undefined));
    if (!response.ok) {
      throw new FreebuffSessionError(
        sessionFailureMessage(body, response.status),
        response.status,
        responseCode(body),
      );
    }
    const session = activeSession(body, model);
    this.active.set(token, { ...session, token });
    return session;
  }

  private async release(session: OwnedSession): Promise<void> {
    try {
      await this.fetchImpl(this.endpoint, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.token}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The Freebuff server-side sweep is the backstop if shutdown happens offline.
    }
  }
}

const managers = new Map<string, FreebuffSessionManager>();

export function getFreebuffSessionManager(baseUrl = DEFAULT_FREEBUFF_APP_URL): FreebuffSessionManager {
  const normalized = normalizeBaseUrl(baseUrl);
  const existing = managers.get(normalized);
  if (existing) return existing;
  const manager = new FreebuffSessionManager({ baseUrl: normalized });
  managers.set(normalized, manager);
  return manager;
}

export async function releaseFreebuffSessions(): Promise<void> {
  await Promise.all([...managers.values()].map(manager => manager.releaseAll()));
}
