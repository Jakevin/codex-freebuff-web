import {
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import type { CodexParsedRequest } from "../types";

/** Compatibility-only route for the retired DEV harness; production never imports this module. */
export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config);
  parsed.modelId = route.backendModel;
  parsed.options.reasoning = route.interactionMode === "automatic" ? route.adapterEffort : route.codexEffort;
  return route;
}
