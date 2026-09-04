export const FREEBUFF_MODEL_PREFIX = "freebuff/";
/** Current free model admitted by the official Freebuff CLI session endpoint. */
export const FREEBUFF_MODEL_ID = "deepseek/deepseek-v4-flash";
/** Current root agent selected by the official Freebuff CLI for that model. */
export const FREEBUFF_AGENT = "base3-free-deepseek-flash";
export const FREEBUFF_MODEL_SLUG = "freebuff/base";

export type FreebuffCodexEffort = "medium";

export interface FreebuffModelRoute {
  slug: typeof FREEBUFF_MODEL_SLUG;
  displayName: string;
  description: string;
  agent: string;
  /** Internal provider model value used by the adapter. */
  backendModel: string;
  codexEffort: FreebuffCodexEffort;
}

export interface FreebuffContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export const FREEBUFF_MODEL_ROUTE: FreebuffModelRoute = {
  slug: FREEBUFF_MODEL_SLUG,
  displayName: "Freebuff — DeepSeek V4 Flash",
  description: "Official Freebuff free coding session through the native Codex harness.",
  agent: FREEBUFF_AGENT,
  backendModel: FREEBUFF_AGENT,
  codexEffort: "medium",
};

export const FREEBUFF_MODEL_ROUTES: readonly FreebuffModelRoute[] = [FREEBUFF_MODEL_ROUTE];

export function isFreebuffModelSlug(modelId: string): boolean {
  return modelId.startsWith(FREEBUFF_MODEL_PREFIX);
}

export function availableFreebuffModelRoutes(): readonly FreebuffModelRoute[] {
  return FREEBUFF_MODEL_ROUTES;
}

export function requireFreebuffModelRoute(modelId: string): FreebuffModelRoute {
  if (modelId === FREEBUFF_MODEL_SLUG) return FREEBUFF_MODEL_ROUTE;
  throw new Error(`Freebuff model is not enabled: ${modelId}`);
}

export function resolveFreebuffContextLimits(contextWindow: number): FreebuffContextLimits {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("Freebuff context window must be a positive integer");
  }
  const autoCompactTokenLimit = Math.max(1, Math.floor(contextWindow * 0.8));
  return {
    contextWindow,
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}
