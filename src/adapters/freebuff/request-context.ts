import { AsyncLocalStorage } from "node:async_hooks";

export interface FreebuffRequestContext {
  instanceId: string;
  /** The per-run trace id sent by the official SDK on every model request. */
  traceSessionId?: string;
  /** Explicit reasoning override, when the Codex request carried one. */
  reasoningEffort?: string;
}

const requestContext = new AsyncLocalStorage<FreebuffRequestContext>();
let installed = false;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function withSessionMetadata(input: RequestInfo | URL, init: RequestInit | undefined): RequestInit | undefined {
  const context = requestContext.getStore();
  if (!context || !init || typeof init.body !== "string") return init;
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return init;
  }
  if (!url.pathname.endsWith("/api/v1/chat/completions")) return init;
  try {
    const body: unknown = JSON.parse(init.body);
    if (!body || typeof body !== "object" || Array.isArray(body)) return init;
    const record = body as Record<string, unknown>;
    const metadata = record.codebuff_metadata;
    record.codebuff_metadata = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      ...(context.traceSessionId ? { trace_session_id: context.traceSessionId } : {}),
      ...(context.reasoningEffort ? { freebuff_reasoning_effort: context.reasoningEffort } : {}),
      freebuff_instance_id: context.instanceId,
    };
    return { ...init, body: JSON.stringify(record) };
  } catch {
    return init;
  }
}

/**
 * Add the current official Freebuff session id to SDK requests.
 *
 * The latest upstream SDK exposes `extraCodebuffMetadata`, but the published npm SDK version
 * used by this bridge predates it. This compatibility layer keeps the request on the official
 * SDK/backend path while supplying the field required by Freebuff's session gate.
 */
export function installFreebuffFetchMetadataBridge(): void {
  if (installed) return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    return originalFetch(input, withSessionMetadata(input, init));
  }) as typeof fetch;
  installed = true;
}

export function withFreebuffRequestContext<T>(
  context: FreebuffRequestContext,
  operation: () => Promise<T> | T,
): Promise<T> | T {
  installFreebuffFetchMetadataBridge();
  return requestContext.run(context, operation);
}
