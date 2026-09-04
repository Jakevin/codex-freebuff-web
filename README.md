<h1 align="center">Freebuff for Codex</h1>

<p align="center">
  <strong>Use Freebuff's official free coding session from Codex's native model picker.</strong><br>
  No ChatGPT Web, no browser automation, no MCP tunnel, no API key.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://freebuff.com/cli">Freebuff CLI</a> ·
  <a href="https://freebuff.com/chat">Freebuff Web Chat</a> ·
  <a href="https://github.com/CodebuffAI/codebuff">Official source</a> ·
  <a href="SECURITY.md">Security</a>
</p>

```text
Codex task ──Responses + SSE──▶ codex-freebuff-web
                                    │
                                    ├─ official Freebuff session admission
                                    └─ @codebuff/sdk ──▶ Freebuff backend

codex-freebuff-web freebuff ──▶ official interactive Freebuff CLI
codex-freebuff-web open chat ──▶ https://freebuff.com/chat
```

This bridge keeps Codex's native Responses/task interface and maps `freebuff/base` and
`freebuff/glm-5.3-flash` to the official Freebuff free coding session. Login uses the official
browser device flow: you sign in once manually. There is no API key to create or paste, and the
official Freebuff CLI is not required.

<p align="center">
  <img src="assets/demo.png" alt="Freebuff for Codex running inside a Codex task, including the Freebuff ad" width="960">
</p>

## Quick start

> For AI-assisted install: in the project directory, run
> `curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD" && "$HOME/.local/bin/codex-freebuff-web" login`
> to install and open the browser for the one-time Freebuff login.

Regular users only need macOS, network access, and a browser; the release bundles the Bun 1.4.0
runtime. Neither Bun nor the official Freebuff CLI needs to be installed.

```bash
# 1. Install the release that bundles Bun
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh

# 2. Complete setup in the project Freebuff should modify
$HOME/.local/bin/codex-freebuff-web setup --full --cwd "$PWD"

# 3. Sign in once in the browser (no Freebuff CLI required)
$HOME/.local/bin/codex-freebuff-web login
```

To combine setup into the install command, run it from the project directory:

```bash
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD"
$HOME/.local/bin/codex-freebuff-web login
```

`codex-freebuff-web login` prints a login URL and opens the browser on macOS; finish the
GitHub/Google sign-in there. The bridge only writes an official-compatible login session to
`~/.config/manicode/credentials.json` — it never fills in your credentials or stores a token in
its own config. On SSH or when you don't want the browser to open, use
`codex-freebuff-web login --no-open`.

macOS setup attempts to install a background service; on other platforms keep the bridge running
manually:

```bash
bun run src/cli.ts serve
```

After restarting Codex, the model picker shows `Freebuff — DeepSeek V4 Flash` and
`Freebuff — GLM 5.3 Flash`. The local `freebuff/base` and `freebuff/glm-5.3-flash` routes map to
the official Freebuff models `deepseek/deepseek-v4-flash` and `z-ai/glm-5.3-flash`.

The bridge applies a 32,000-character safety limit to the latest user/agent message in each
turn, based on the Freebuff Web input boundary. Over-limit input returns an error asking you to
shorten the message and retry, instead of silently truncating it. The public official CLI source
has no fixed prompt character limit today; it relies on the token context window and context
pruning.

## Ads in Codex

After every successful Freebuff reply, a text ad clearly labeled `Ad · Freebuff` is displayed.
The bridge prefers the same `/api/v1/ads` endpoint used by the official CLI; when the ad service
has no fill or is unreachable, it shows the official Freebuff house ad. Ads are a separate
Responses output: they never enter the model prompt and are not counted in reply token usage. Ad
decisions only send the current user message, never the system prompt, repository history, tool
results, or assistant replies. Impressions are reported best-effort after an ad is shown, and a
failure never affects the coding task.

Read-only mode:

```bash
bun run src/cli.ts setup --read-only --cwd "$PWD"
```

## Web Chat

Freebuff Web Chat is a separate browser product entry point for research and general
conversation; it is not this bridge's workspace coding transport. Open it with:

```bash
codex-freebuff-web open chat
# or
codex-freebuff-web webchat
```

Sign in on the Web Chat page manually. Web Chat browser cookies do not automatically become
bridge credentials; run `codex-freebuff-web login` before using the Codex bridge for local coding
tasks.

## Using the official CLI

The official `freebuff` npm package is an interactive terminal TUI and does not expose a
one-shot stdout protocol that can be safely parsed into Responses/SSE. It is therefore kept only
as an optional interactive entry point; each Codex task uses the official `@codebuff/sdk`, reads
the same official-compatible login session, and uses official Freebuff session admission with
`costMode=free`.

```bash
# Launch the official CLI directly (optional; the bridge does not need it)
freebuff

# Or forward all official CLI arguments through the bridge
codex-freebuff-web freebuff

# Open the official CLI docs
codex-freebuff-web open cli
```

## Setup & diagnostics

```bash
codex-freebuff-web doctor
codex-freebuff-web service status
codex-freebuff-web route status
codex-freebuff-web open cli
codex-freebuff-web open chat
codex-freebuff-web uninstall --yes
```

The bridge listens on `127.0.0.1:17841` by default, with the Responses endpoint at `/v1`.
Setup accepts `--port`, `--cwd`, `--agent`, and `--max-agent-steps`.

If your credentials live somewhere other than the default path, point setup at them:

```bash
codex-freebuff-web setup --credentials-path "/absolute/path/credentials.json" --cwd "$PWD"
```

`CODEBUFF_API_KEY` and `--api-key` remain only as a compatibility fallback for older setups; the
normal Freebuff free flow needs no API key.

## Development

Bun is only needed when developing from source or building the release yourself:

```bash
bun run typecheck
bun test tests/freebuff.test.ts
bun run build
```

The project lives at [Jakevin/codex-freebuff-web](https://github.com/Jakevin/codex-freebuff-web).
Freebuff's source lives at [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff).

## License

The upstream project is MIT. The Codebuff SDK is Apache-2.0; see the third-party notices in
[LICENSES](LICENSES).