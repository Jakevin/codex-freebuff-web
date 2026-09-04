import type { AgentDefinition } from "@codebuff/sdk";
import { FREEBUFF_AGENT, FREEBUFF_MODEL_ID } from "../../freebuff-models";

/**
 * The root definition bundled by the official Freebuff CLI for DeepSeek Flash.
 *
 * Free mode is intentionally admitted only for first-party root prompts. The
 * public SDK package used by this bridge does not bundle the CLI registry, so
 * the bridge must provide this definition explicitly to reproduce the CLI
 * request shape. In particular, the canonical first sentence is checked by
 * Freebuff's server-side free-mode admission gate.
 */
export const FREEBUFF_ROOT_AGENT_DEFINITION: AgentDefinition = {
  id: FREEBUFF_AGENT,
  publisher: "codebuff",
  model: FREEBUFF_MODEL_ID,
  providerOptions: { data_collection: "deny" },
  displayName: "Buffy on DeepSeek Flash",
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
    `You are running on the ${FREEBUFF_MODEL_ID} model.`,
    "You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free. See freebuff.com for more information about the product.",
  ].join("\n"),
};

