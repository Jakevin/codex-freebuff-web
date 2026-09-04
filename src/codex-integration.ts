import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, defaultConfig, getConfigPath, loadConfig, saveConfig } from "./config";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexManagedModelCatalogPath,
  getCodexModelsCachePath,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { augmentNativeModelCatalog } from "./model-catalog";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  findTopLevelAssignment,
  firstTableIndex,
  installCompatibilityV1Features,
  insertDocumentLine,
  parseDocument,
  readCodexModelContextOverride,
  renderDocument,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  assertPreservedPreviousProviderBaseUrl,
  assertPreservedPreviousRealtimeAssignment,
  installProviderBaseUrl,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

const FALLBACK_NATIVE_CODEX_CATALOG = {
  models: [{
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    default_reasoning_level: "low",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
      { effort: "high", description: "Greater reasoning depth for complex tasks" },
      { effort: "xhigh", description: "Extra high reasoning depth for complex tasks" },
      { effort: "max", description: "Maximum reasoning depth for the hardest tasks" },
      { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
    ],
    visibility: "list",
    supported_in_api: true,
    tool_mode: "code_mode_only",
    priority: 1,
  }],
};

function nativeCatalogForManagedRoute(): unknown {
  for (const sourcePath of [getCodexModelsCachePath(), getCodexManagedModelCatalogPath()]) {
    if (!existsSync(sourcePath)) continue;
    try {
      return JSON.parse(readFileSync(sourcePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Codex model catalog is not valid JSON: ${sourcePath}; ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return FALLBACK_NATIVE_CODEX_CATALOG;
}

function buildManagedModelCatalog(config: Pick<AppConfig, "mode" | "subagentProtocol" | "contextWindow">): {
  path: string;
  data: string;
  sha256: string;
} {
  const catalog = augmentNativeModelCatalog(
    nativeCatalogForManagedRoute(),
    config,
    readCodexModelContextOverride(),
  );
  const data = `${JSON.stringify(catalog)}\n`;
  return {
    path: getCodexManagedModelCatalogPath(),
    data,
    sha256: sha256(data),
  };
}

function installManagedModelCatalogRoute(
  text: string,
  catalogPath: string,
  replaceExistingRoute: boolean,
): string {
  const document = parseDocument(text);
  const current = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (current.present && current.value !== catalogPath && !replaceExistingRoute) {
    throw new Error(
      `Codex already configures model_catalog_json=${JSON.stringify(current.value)}. `
      + "Rerun with --replace-codex-route to replace it reversibly.",
    );
  }
  const installedLine = `model_catalog_json = ${JSON.stringify(catalogPath)}`;
  if (current.index !== undefined) document.lines[current.index] = installedLine;
  else insertDocumentLine(document, firstTableIndex(document.lines), installedLine);
  return renderDocument(document);
}

function assertManagedCatalogUnchanged(journal: AnyCodexIntegrationJournal | undefined): void {
  if (journal?.version !== 9 || journal.installed.model_catalog_json === undefined) return;
  const path = journal.installed.model_catalog_json;
  if (!existsSync(path) || journal.installed.model_catalog_json_sha256 === undefined) return;
  if (sha256(readFileSync(path)) !== journal.installed.model_catalog_json_sha256) {
    throw new Error(`Managed Codex model catalog changed after setup: ${path}`);
  }
}

function managedCatalogRemovals(
  existing: AnyCodexIntegrationJournal | undefined,
  nextCatalogPath: string | undefined,
): string[] {
  assertManagedCatalogUnchanged(existing);
  if (existing?.version !== 9 || existing.installed.model_catalog_json === undefined) return [];
  const path = existing.installed.model_catalog_json;
  return path === nextCatalogPath ? [] : [path];
}

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "mode" | "subagentProtocol" | "contextWindow"> & { provider?: AppConfig["provider"] },
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  previousProviderBaseUrl?: CodexIntegrationJournal["previousProviderBaseUrl"];
  installedProviderBaseUrl?: CodexIntegrationJournal["installed"]["provider_base_url"];
  modelCatalog?: {
    path: string;
    data: string;
    sha256: string;
  };
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
    config.provider !== "freebuff",
  );
  let text = route.text;
  let previousProviderBaseUrl: CodexIntegrationJournal["previousProviderBaseUrl"];
  let installedProviderBaseUrl: CodexIntegrationJournal["installed"]["provider_base_url"];
  let modelCatalog: {
    path: string;
    data: string;
    sha256: string;
  } | undefined;
  const provider = route.previous.model_provider.value;
  if (config.provider === "freebuff" && provider && provider !== "openai") {
    const providerRoute = installProviderBaseUrl(text, installedUrl, replaceExistingRoute);
    text = providerRoute.text;
    previousProviderBaseUrl = providerRoute.previous;
    installedProviderBaseUrl = providerRoute.installed;
    modelCatalog = buildManagedModelCatalog(config);
    text = installManagedModelCatalogRoute(text, modelCatalog.path, replaceExistingRoute);
  }
  if (config.subagentProtocol !== "compatibility-v1") {
    return {
      text,
      previous: route.previous,
      previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
      ...(previousProviderBaseUrl ? { previousProviderBaseUrl } : {}),
      ...(installedProviderBaseUrl ? { installedProviderBaseUrl } : {}),
      ...(modelCatalog ? { modelCatalog } : {}),
    };
  }
  const features = installCompatibilityV1Features(text);
  return {
    text: features.text,
    previous: route.previous,
    previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
    previousMultiAgent: features.previousMultiAgent,
    previousMultiAgentV2: features.previousMultiAgentV2,
    previousAgentMaxDepth: features.previousAgentMaxDepth,
    installedAgentMaxDepth: features.installedAgentMaxDepth,
    ...(previousProviderBaseUrl ? { previousProviderBaseUrl } : {}),
    ...(installedProviderBaseUrl ? { installedProviderBaseUrl } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
  };
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 ? journal.installed.subagent_protocol : "native";
}

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexManagedModelCatalogPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
): AppConfig["subagentProtocol"] {
  const journal = readJournal();
  return journal?.version === 8 || journal?.version === 9 ? journal.installed.subagent_protocol : fallback;
}

export function setCodexSubagentProtocol(
  config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  const status = inspectCodexIntegration();
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const nextConfig = { ...config, subagentProtocol: protocol };
  // The runtime catalog and Codex feature surface are two halves of one protocol selection. If
  // either write fails, restore every participant so the next launcher/Codex restart cannot load a
  // split V1/V2 state.
  const snapshots = [
    getConfigPath(),
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexManagedModelCatalogPath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(snapshotFile);
  try {
    const journal = installCodexIntegration(nextConfig);
    saveConfig(nextConfig);
    return journal;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; subagent protocol rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      installConfiguredRoute("", installedUrl, config, true, true);
      return;
    }
    try {
      verifyManagedJournalState(currentText, existing);
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      installConfiguredRoute(
        replacementBaseline(currentText, configExists, existing),
        installedUrl,
        config,
        true,
        true,
      );
      return;
    }
    if (existing.version === 9) return;
    const baseline = managedJournalIsActive(existing)
      ? restoreManagedRoute(currentText, existing)
      : currentText;
    installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      options.replaceExistingRoute === true,
    );
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedJournalState(currentText, existing);
      baseline = managedJournalIsActive(existing)
        ? restoreManagedRoute(currentText, existing)
        : currentText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || options.replaceExistingRoute === true,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      const preservesProviderBaseUrl = existing.version === 9
        && existing.installed.provider_base_url?.provider === patched.installedProviderBaseUrl?.provider;
      assertPreservedPreviousProviderBaseUrl(
        patched.previousProviderBaseUrl,
        preservesProviderBaseUrl ? existing.previousProviderBaseUrl : undefined,
      );
      if (config.provider !== "freebuff"
        && existing.version === 9
        && existing.previousRealtimeWebrtcCallBaseUrl !== undefined
        && patched.previousRealtimeWebrtcCallBaseUrl !== undefined) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 9,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        ...(config.provider !== "freebuff" ? {
          experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        } : {}),
        subagent_protocol: config.subagentProtocol,
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
        ...(patched.installedProviderBaseUrl ? {
          provider_base_url: patched.installedProviderBaseUrl,
        } : {}),
        ...(patched.modelCatalog ? {
          model_catalog_json: patched.modelCatalog.path,
          model_catalog_json_sha256: patched.modelCatalog.sha256,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      ...(patched.previousProviderBaseUrl ? {
        previousProviderBaseUrl: preservePrevious
          && existing.version === 9
          && existing.installed.provider_base_url?.provider === patched.installedProviderBaseUrl?.provider
          && existing.previousProviderBaseUrl
          ? existing.previousProviderBaseUrl
          : patched.previousProviderBaseUrl,
      } : {}),
      previousRealtimeWebrtcCallBaseUrl: config.provider === "freebuff"
        ? { present: false }
        : preservePrevious && existing.version === 9
          ? existing.previousRealtimeWebrtcCallBaseUrl ?? patched.previousRealtimeWebrtcCallBaseUrl
          : patched.previousRealtimeWebrtcCallBaseUrl,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    writeIntegrationState(
      updated,
      { path: configPath, data: patched.text },
      [getCodexModelsCachePath(), ...managedCatalogRemovals(existing, patched.modelCatalog?.path)],
      patched.modelCatalog ? [{ path: patched.modelCatalog.path, data: patched.modelCatalog.data }] : [],
    );
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
  );
  const journal: CodexIntegrationJournal = {
    version: 9,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      ...(config.provider !== "freebuff" ? {
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      } : {}),
      subagent_protocol: config.subagentProtocol,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
      ...(patched.installedProviderBaseUrl ? {
        provider_base_url: patched.installedProviderBaseUrl,
      } : {}),
      ...(patched.modelCatalog ? {
        model_catalog_json: patched.modelCatalog.path,
        model_catalog_json_sha256: patched.modelCatalog.sha256,
      } : {}),
    },
    previous: patched.previous,
    ...(patched.previousProviderBaseUrl ? {
      previousProviderBaseUrl: patched.previousProviderBaseUrl,
    } : {}),
    previousRealtimeWebrtcCallBaseUrl: config.provider === "freebuff"
      ? { present: false }
      : patched.previousRealtimeWebrtcCallBaseUrl,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  writeIntegrationState(
    journal,
    { path: configPath, data: patched.text },
    [getCodexModelsCachePath()],
    patched.modelCatalog ? [{ path: patched.modelCatalog.path, data: patched.modelCatalog.data }] : [],
  );
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9) && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, [getCodexModelsCachePath()]);
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if (existing.version === 9 && existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9) && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const configured = existsSync(getConfigPath()) ? loadConfig() : defaultConfig("browser-only");
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { ...configured, subagentProtocol: protocol, provider: "freebuff" },
    true,
    existing.version === 9,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  assertPreservedPreviousProviderBaseUrl(
    route.previousProviderBaseUrl,
    existing.version === 9 ? existing.previousProviderBaseUrl : undefined,
  );
  const connected: CodexIntegrationJournal = {
    version: 9,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      subagent_protocol: protocol,
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
      ...(route.installedProviderBaseUrl ? {
        provider_base_url: route.installedProviderBaseUrl,
      } : {}),
      ...(route.modelCatalog ? {
        model_catalog_json: route.modelCatalog.path,
        model_catalog_json_sha256: route.modelCatalog.sha256,
      } : {}),
    },
    previous: existing.previous,
    ...(route.previousProviderBaseUrl ? {
      previousProviderBaseUrl: route.previousProviderBaseUrl,
    } : {}),
    previousRealtimeWebrtcCallBaseUrl: { present: false },
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(
    connected,
    { path: existing.configPath, data: route.text },
    [getCodexModelsCachePath(), ...managedCatalogRemovals(existing, route.modelCatalog?.path)],
    route.modelCatalog ? [{ path: route.modelCatalog.path, data: route.modelCatalog.data }] : [],
  );
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  assertManagedCatalogUnchanged(journal);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9) && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  const configSnapshot = snapshotFile(journal.configPath);
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const managedCatalogSnapshot = journal.version === 9 && journal.installed.model_catalog_json !== undefined
    ? snapshotFile(journal.installed.model_catalog_json)
    : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    atomicWriteFile(journal.configPath, restored);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    if (managedCatalogSnapshot?.exists) rmSync(managedCatalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [
      recoverySnapshot,
      journalSnapshot,
      modelsCacheSnapshot,
      managedCatalogSnapshot,
      catalogSnapshot,
      configSnapshot,
    ]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9) && !journal.active) {
        verifyRestoredRoute(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9) {
        verifyInstalledRoute(text, journal);
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
