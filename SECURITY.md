# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. The Freebuff SDK currently pins an older AI provider-utils major; forcing
the newer major breaks the SDK's exported tool factory, so the lockfile instead pins `undici` to the
patched 6.28.0 line. Run `bun run audit` before promoting a release. CI and release builds skip the
network-dependent audit request because the npm advisory endpoint can return transient 503/timeouts;
that skip does not suppress the local audit command or its findings.

Once the GitHub repository is public, use its private Security Advisory reporting flow. Until that
is enabled, do not publish a proof of concept that exposes credentials or arbitrary local tool
execution; contact the maintainer privately through the GitHub account listed by the repository.
