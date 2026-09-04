import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableFreebuffModelRoutes,
  FREEBUFF_MODEL_PREFIX,
  resolveFreebuffContextLimits,
  type FreebuffModelRoute,
} from "./freebuff-models";

type JsonObject = Record<string, unknown>;
type ModelCatalogConfig = Pick<AppConfig, "mode" | "subagentProtocol" | "contextWindow">;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

function modelPriority(template: JsonObject): number | undefined {
  const value = template.priority;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Native Codex model template priority must be an integer");
  }
  return value;
}

function routedModelPriority(
  template: JsonObject,
  route: FreebuffModelRoute,
  config: ModelCatalogConfig,
): number | undefined {
  const priority = modelPriority(template);
  if (priority === undefined
    || config.subagentProtocol !== "compatibility-v1"
    || route.slug !== "freebuff/base") return priority;
  if (priority === Number.MAX_SAFE_INTEGER) {
    throw new Error("Native Codex model template priority cannot reserve the Compatibility V1 roster");
  }
  // Codex V1 exposes at most five model overrides. Keep the native Sol row plus the four useful
  // delegated Web efforts (Medium, High, Extra High, Pro); Instant remains a selectable root model
  // but does not displace Pro from spawn_agent's bounded registry.
  return priority + 1;
}

function nativeTemplateCandidate(value: unknown, requireTools: boolean): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as JsonObject;
  const modelSlug = slug(model);
  if (!modelSlug || modelSlug.startsWith(FREEBUFF_MODEL_PREFIX)) return false;
  if (model.visibility !== "list") return false;
  if (!Array.isArray(model.supported_reasoning_levels)) return false;
  return !requireTools || (typeof model.tool_mode === "string" && model.tool_mode.length > 0);
}

function selectNativeTemplate(models: unknown[], config: ModelCatalogConfig): JsonObject {
  const requireTools = config.mode === "full";
  const candidates = models.filter(model => nativeTemplateCandidate(model, requireTools)) as JsonObject[];
  const template = candidates[0];
  if (template) return template;
  throw new Error(
    requireTools
      ? "Native Codex models response has no list-visible, tool-capable model with reasoning metadata"
      : "Native Codex models response has no list-visible model with reasoning metadata",
  );
}

function useCompatibilityV1SubagentSurface(model: JsonObject): void {
  // Compatibility V1 is an explicit whole-task protocol mode. Preserve an explicit disabled
  // capability instead of advertising support that the native model denied.
  if (model.multi_agent_version !== "disabled") model.multi_agent_version = "v1";
}

function routedSubagentVersion(template: JsonObject, config: ModelCatalogConfig): string | undefined {
  if (config.subagentProtocol === "compatibility-v1") return "v1";
  return typeof template.multi_agent_version === "string" ? template.multi_agent_version : undefined;
}

export function buildFreebuffModel(
  templateValue: unknown,
  route: FreebuffModelRoute,
  config: ModelCatalogConfig,
): JsonObject {
  const template = object(templateValue, "native Codex model template");
  const templateSlug = slug(template);
  if (!templateSlug || templateSlug.startsWith(FREEBUFF_MODEL_PREFIX)) {
    throw new Error("Freebuff model template must be a native Codex model");
  }
  const limits = resolveFreebuffContextLimits(config.contextWindow);
  const multiAgentVersion = routedSubagentVersion(template, config);
  const priority = routedModelPriority(template, route, config);
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text", "image"],
    visibility: "list",
    // This slug is implemented by this local Responses-compatible bridge.
    supported_in_api: true,
    // Follow the official template's ordering without outranking it. Codex advertises at most five
    // spawn-agent overrides; forcing every routed row to priority 0 displaced gpt-5.6-sol from that
    // registry and made an explicit native child model fail validation.
    ...(priority === undefined ? {} : { priority }),
    // Compatibility V1 keeps cross-backend collaboration on the plaintext contract understood by
    // this bridge. The Freebuff SDK owns its own internal subagents.
    ...(multiAgentVersion === undefined
      ? {}
      : { multi_agent_version: multiAgentVersion }),
    // The route uses the regular Responses surface so the native Codex UI can select it.
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: route.codexEffort,
    supported_reasoning_levels: [reasoningLevel(template, route.codexEffort, route.displayName)],
    context_window: limits.contextWindow,
    max_context_window: limits.contextWindow,
    effective_context_window_percent: limits.effectiveContextWindowPercent,
    auto_compact_token_limit: limits.autoCompactTokenLimit,
    // Freebuff has no Codex service tier. Never inherit the native template's Fast tiers.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  // A native template's compaction hash describes OpenAI's native model contract, not this routed
  // Freebuff model. The explicit Freebuff window above is owned by this adapter and never copied
  // back to native models or the user's top-level model_context_window setting.
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: ModelCatalogConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => !slug(model)?.startsWith(FREEBUFF_MODEL_PREFIX)),
  );
  if (config.subagentProtocol === "compatibility-v1") {
    for (const candidate of nativeModels) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        useCompatibilityV1SubagentSurface(candidate as JsonObject);
      }
    }
  }
  const template = selectNativeTemplate(nativeModels, config);
  if (contextOverride) {
    // model_context_window is a single top-level Codex setting, not a per-model one. Apply its
    // advertised maximum to every native row so switching native models cannot silently clamp the
    // effective override. Codex itself applies context_window and auto-compaction configuration.
    for (const candidate of nativeModels) {
      const modelSlug = slug(candidate);
      if (!modelSlug) continue;
      const model = object(candidate, `native ${modelSlug} model`);
      const current = model.max_context_window;
      if (current !== undefined && current !== null
        && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) {
        throw new Error(`Native ${modelSlug} max_context_window must be a positive integer`);
      }
      if (current === undefined || current === null || current < contextOverride.contextWindow) {
        model.max_context_window = contextOverride.contextWindow;
      }
    }
  }
  const freebuffModels = availableFreebuffModelRoutes()
    .map(route => buildFreebuffModel(template, route, config));
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, ...freebuffModels],
  };
}
