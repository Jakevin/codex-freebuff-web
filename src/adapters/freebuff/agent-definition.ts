import type { AgentDefinition } from "@codebuff/sdk";
import {
  FREEBUFF_AGENT,
  FREEBUFF_GLM_V53_FLASH_AGENT,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  FREEBUFF_MIMO_AGENT,
  FREEBUFF_MIMO_MODEL_ID,
  FREEBUFF_MUSE_SPARK_13_AGENT,
  FREEBUFF_MUSE_SPARK_13_MODEL_ID,
  FREEBUFF_MODEL_ID,
  FREEBUFF_SOLAR_PRO4_AGENT,
  FREEBUFF_SOLAR_PRO4_MODEL_ID,
} from "../../freebuff-models";

/**
 * The root definitions bundled by the official Freebuff CLI for its free models.
 *
 * Free mode is intentionally admitted only for first-party root prompts. The
 * public SDK package used by this bridge does not bundle the CLI registry, so
 * the bridge must provide this definition explicitly to reproduce the CLI
 * request shape. In particular, the canonical first sentence is checked by
 * Freebuff's server-side free-mode admission gate.
 */
function createFreebuffRootAgentDefinition(
  id: string,
  model: string,
  displayName: string,
): AgentDefinition {
  return {
    id,
    publisher: "codebuff",
    model,
    providerOptions: { data_collection: "deny" },
    displayName,
    spawnerPrompt: "Single-loop coding agent that explores, edits, and verifies directly with its own tools",
    inputSchema: {
      prompt: {
        type: "string",
        description: "A coding task to complete",
      },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    // Keep this to the base3 harness tools understood by the installed SDK.
    // The official CLI adds UI-only tools around the same root definition.
    toolNames: [
      "read_files",
      "str_replace",
      "write_file",
      "run_terminal_command",
      "code_search",
      "glob",
      "list_directory",
      "write_todos",
    ],
    systemPrompt: [
      "You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.",
      "",
      `Current date: ${new Date().toISOString().slice(0, 10)}.`,
      "",
      "- Match the project's existing conventions. Verify a library is already used in the project before employing it.",
      "- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.",
      "- Verify non-trivial changes by running the project's typecheck and relevant tests.",
      "- Use write_todos to plan and track multi-step tasks.",
      "- Your responses are displayed in a terminal. Keep them short and concise.",
      "- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.",
      "",
      "# Freebuff Meta-information",
      "",
      `You are running on the ${model} model.`,
      "You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free. See freebuff.com for more information about the product.",
    ].join("\n"),
  };
}

export const FREEBUFF_ROOT_AGENT_DEFINITION = createFreebuffRootAgentDefinition(
  FREEBUFF_AGENT,
  FREEBUFF_MODEL_ID,
  "Buffy on DeepSeek Flash",
);

export const FREEBUFF_GLM_ROOT_AGENT_DEFINITION = createFreebuffRootAgentDefinition(
  FREEBUFF_GLM_V53_FLASH_AGENT,
  FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  "Buffy on GLM 5.3 Flash",
);

export const FREEBUFF_MIMO_ROOT_AGENT_DEFINITION = createFreebuffRootAgentDefinition(
  FREEBUFF_MIMO_AGENT,
  FREEBUFF_MIMO_MODEL_ID,
  "Buffy on MiMo 2.5",
);

export const FREEBUFF_SOLAR_PRO4_ROOT_AGENT_DEFINITION = createFreebuffRootAgentDefinition(
  FREEBUFF_SOLAR_PRO4_AGENT,
  FREEBUFF_SOLAR_PRO4_MODEL_ID,
  "Buffy on Solar Pro 4",
);

export const FREEBUFF_MUSE_SPARK_13_ROOT_AGENT_DEFINITION = createFreebuffRootAgentDefinition(
  FREEBUFF_MUSE_SPARK_13_AGENT,
  FREEBUFF_MUSE_SPARK_13_MODEL_ID,
  "Buffy on Muse Spark 1.3",
);

export function freebuffRootAgentDefinitionFor(agent: string): AgentDefinition | undefined {
  if (agent === FREEBUFF_AGENT) return FREEBUFF_ROOT_AGENT_DEFINITION;
  if (agent === FREEBUFF_GLM_V53_FLASH_AGENT) return FREEBUFF_GLM_ROOT_AGENT_DEFINITION;
  if (agent === FREEBUFF_MIMO_AGENT) return FREEBUFF_MIMO_ROOT_AGENT_DEFINITION;
  if (agent === FREEBUFF_SOLAR_PRO4_AGENT) return FREEBUFF_SOLAR_PRO4_ROOT_AGENT_DEFINITION;
  if (agent === FREEBUFF_MUSE_SPARK_13_AGENT) return FREEBUFF_MUSE_SPARK_13_ROOT_AGENT_DEFINITION;
  return undefined;
}
