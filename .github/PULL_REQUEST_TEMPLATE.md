## What this changes

<!-- Describe one focused behavior change. Link the issue or prior discussion when applicable.
Large features, broad refactors, rewrites, new providers, and core architecture changes are normally
not accepted without prior maintainer discussion; prior discussion does not guarantee acceptance. -->

Fixes #

## Evidence

<!-- Give the reproduction before the change and the exact result afterward. Browser UI changes need observed DOM evidence, not guessed selectors. -->

## Scope and invariants

- [ ] I read and followed `CONTRIBUTING.md`.
- [ ] This is a small, focused change with no unrelated cleanup or generated rewrite.
- [ ] The change stays focused on the local Freebuff-backed Codex Responses bridge; it does not add a generic provider or unrelated product surface.
- [ ] Model, route, effort, connector, and capability selection remain explicit with no silent fallback or false-success path.
- [ ] Freebuff model, route, agent, effort, and capability selection remain explicit with no browser, ChatGPT Web, or tunnel fallback.
- [ ] Terms and trademark claims remain factual; this change is not marketed as a quota or rate-limit bypass.

## Verification

- [ ] I ran `bun install --frozen-lockfile` in the repository root.
- [ ] I ran `bun run verify` with the Bun version pinned by `package.json`.
- [ ] I added or updated a focused regression test for behavior changes.
- [ ] I manually tested the affected behavior.
- [ ] If this changes local tools or the outer Codex agent loop, I tested it through a real installed Codex integration or a focused SDK fixture and documented which one.
- [ ] I did not commit browser state, credentials, Tunnel IDs, raw logs, generated artifacts, or private paths.
- [ ] I did not include an unrelated dependency update, release artifact, or version change.

## Platform or account validation

<!-- List the platforms, account tiers, Browser-only/Full modes, and packaged builds actually exercised. Write "not run" for anything not verified. -->
