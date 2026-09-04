import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runCommand } from "./process";

export const OFFICIAL_FREEBUFF_CLI_COMMAND = "freebuff";

function pathEntries(): string[] {
  return (process.env.PATH || process.env.Path || "")
    .split(process.platform === "win32" ? ";" : ":")
    .map(entry => entry.trim())
    .filter(Boolean);
}

export function configuredFreebuffCliPath(value?: string): string {
  return value?.trim() || process.env.FREEBUFF_CLI_PATH?.trim() || OFFICIAL_FREEBUFF_CLI_COMMAND;
}

export function officialFreebuffCliAvailable(value?: string): boolean {
  const command = configuredFreebuffCliPath(value);
  if (isAbsolute(command)) {
    if (!existsSync(command)) return false;
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const candidates = process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  return pathEntries().some(directory => candidates.some(candidate => {
    const path = join(directory, candidate);
    if (!existsSync(path)) return false;
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

export function runOfficialFreebuffCli(args: string[], cliPath?: string): number {
  const command = configuredFreebuffCliPath(cliPath);
  try {
    const result = runCommand(command, args, { stdio: "inherit" });
    return result.status;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error("The optional official Freebuff CLI was not found. Use `codex-freebuff-web login` for the built-in login, or install the CLI from https://freebuff.com/cli.");
    }
    throw error;
  }
}
