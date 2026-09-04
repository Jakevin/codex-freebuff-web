import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-freebuff-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  if (process.env.CODEX_FREEBUFF_WEB_SKIP_AUDIT === "1") {
    process.stdout.write("Skipping network dependency audit; run `bun run audit` for the full local check.\n");
  } else {
    await run(["run", "audit"]);
  }
  await run(["run", "typecheck"]);
  await run(["run", "test"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
