export const FREEBUFF_MODEL_PREFIX = "freebuff/";
/** Current free model admitted by the official Freebuff CLI session endpoint. */
export const FREEBUFF_MODEL_ID = "deepseek/deepseek-v4-flash";
/** Current root agent selected by the official Freebuff CLI for that model. */
export const FREEBUFF_AGENT = "base3-free-deepseek-flash";
export const FREEBUFF_MODEL_SLUG = "freebuff/base";
/** Official Freebuff model ID for the GLM 5.3 Flash route. */
export const FREEBUFF_GLM_V53_FLASH_MODEL_ID = "z-ai/glm-5.3-flash";
/** Official Freebuff root agent paired with GLM 5.3 Flash. */
export const FREEBUFF_GLM_V53_FLASH_AGENT = "base3-free-glm-5-3-flash";
export const FREEBUFF_GLM_V53_FLASH_MODEL_SLUG = "freebuff/glm-5.3-flash";

export type FreebuffCodexEffort = "medium";

export interface FreebuffModelRoute {
  slug: string;
  displayName: string;
  description: string;
  agent: string;
  /** Internal provider model value used by the adapter after route selection. */
  backendModel: string;
  /** Official Freebuff model sent to the session-admission endpoint. */
  providerModel: string;
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
  providerModel: FREEBUFF_MODEL_ID,
  codexEffort: "medium",
};

export const FREEBUFF_GLM_V53_FLASH_MODEL_ROUTE: FreebuffModelRoute = {
  slug: FREEBUFF_GLM_V53_FLASH_MODEL_SLUG,
  displayName: "Freebuff — GLM 5.3 Flash",
  description: "Official Freebuff GLM 5.3 Flash coding session through the native Codex harness.",
  agent: FREEBUFF_GLM_V53_FLASH_AGENT,
  backendModel: FREEBUFF_GLM_V53_FLASH_AGENT,
  providerModel: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  codexEffort: "medium",
};

export const FREEBUFF_MODEL_ROUTES: readonly FreebuffModelRoute[] = [
  FREEBUFF_MODEL_ROUTE,
  FREEBUFF_GLM_V53_FLASH_MODEL_ROUTE,
];

export function isFreebuffModelSlug(modelId: string): boolean {
  return modelId.startsWith(FREEBUFF_MODEL_PREFIX);
}

export function availableFreebuffModelRoutes(): readonly FreebuffModelRoute[] {
  return FREEBUFF_MODEL_ROUTES;
}

export function requireFreebuffModelRoute(modelId: string): FreebuffModelRoute {
  const route = FREEBUFF_MODEL_ROUTES.find(candidate => candidate.slug === modelId);
  if (route) return route;
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
