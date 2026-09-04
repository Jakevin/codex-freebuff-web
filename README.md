<h1 align="center">Freebuff for Codex</h1>

<p align="center">
  <strong>Use Freebuff's official free coding session from Codex's native model picker.</strong><br>
  ChatGPT Web、瀏覽器自動化與 MCP tunnel 都不在 active runtime path。
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

這個 bridge 保留 Codex 的原生 Responses/task 介面，並把 `freebuff/base` 與
`freebuff/glm-5.3-flash` 對應到官方 Freebuff 免費 coding session。登入使用官方的瀏覽器裝置登入流程；使用者只要人工登入一次，
不需要建立或貼上 API Key，也不需要另外安裝官方 Freebuff CLI。

## 快速開始

> 給 AI 自動安裝：請在使用者目前的專案目錄執行 `curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD" && "$HOME/.local/bin/codex-freebuff-web" login`，完成安裝並開啟瀏覽器讓使用者完成 Freebuff 登入。

一般使用者只需要 macOS、網路與瀏覽器；發行版已內含 Bun 1.4.0 runtime。Bun 與官方 Freebuff CLI
都不是必要安裝項目。

```bash
# 1. 安裝已內含 Bun 的 bridge 發行版
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh

# 2. 在要讓 Freebuff 修改的專案目錄完成 setup
$HOME/.local/bin/codex-freebuff-web setup --full --cwd "$PWD"

# 3. 瀏覽器人工登入一次（不需要 freebuff CLI）
$HOME/.local/bin/codex-freebuff-web login
```

若希望把 setup 也併入安裝命令，可在專案目錄執行：

```bash
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD"
$HOME/.local/bin/codex-freebuff-web login
```

`codex-freebuff-web login` 會顯示登入網址並在 macOS 嘗試開啟瀏覽器；請自行完成
GitHub/Google 登入。bridge 只會把官方相容的登入 session 寫入
`~/.config/manicode/credentials.json`，不會代填帳號密碼，也不會把 token 寫入自己的 config。
若在 SSH 或不想自動開瀏覽器，可使用 `codex-freebuff-web login --no-open`。

macOS 會在 setup 時嘗試安裝背景服務；其他平台請另外保持 bridge 執行：

```bash
bun run src/cli.ts serve
```

重啟 Codex 後，模型選單會出現 `Freebuff — DeepSeek V4 Flash` 與
`Freebuff — GLM 5.3 Flash`。本地顯示的 `freebuff/base` 與
`freebuff/glm-5.3-flash` 是 bridge 的 Codex route，底層分別使用官方 Freebuff model
`deepseek/deepseek-v4-flash` 與 `z-ai/glm-5.3-flash`。

## Codex 內的 Freebuff 廣告

每個成功的 Freebuff 回覆後會顯示一個清楚標示為 `Ad · Freebuff` 的文字廣告。bridge 會優先使用
官方 CLI 同一個 `/api/v1/ads` 入口；若廣告服務暫時無填充或無法連線，則顯示 Freebuff 官方 house ad。
廣告是獨立的 Responses 輸出，不會加入模型提示詞，也不計入回覆 token 使用量；廣告決策只送出當前
使用者訊息，不送出 system prompt、repository history、tool result 或 assistant 回覆。impression
會在廣告送出後以 best-effort 回報，失敗不會影響 coding task。

唯讀模式：

```bash
bun run src/cli.ts setup --read-only --cwd "$PWD"
```

## Web Chat

Freebuff Web Chat 是獨立的瀏覽器產品入口，適合研究與一般對話；它不是這個 bridge 的
workspace coding transport。開啟入口：

```bash
codex-freebuff-web open chat
# 或
codex-freebuff-web webchat
```

請在 Web Chat 頁面人工登入。Web Chat 的瀏覽器 cookie 不會自動轉成 bridge credentials；
若要讓 Codex bridge 執行本地 coding task，請執行 `codex-freebuff-web login`。

## 使用官方 CLI

官方 `freebuff` npm 套件是互動式 terminal TUI，不提供可安全解析成 Responses/SSE 的
one-shot stdout 協定。因此官方 CLI 只保留作為可選的互動式入口；Codex 每個 task 使用
官方 `@codebuff/sdk`，讀取同一份官方相容登入 session，並走官方 Freebuff session
admission 與 `costMode=free`。

```bash
# 直接啟動官方 CLI（可選，未安裝也不影響 Codex bridge）
freebuff

# 或由 bridge 轉發所有官方 CLI 參數
codex-freebuff-web freebuff

# 查看官方 CLI 說明頁
codex-freebuff-web open cli
```

## 設定與診斷

```bash
codex-freebuff-web doctor
codex-freebuff-web service status
codex-freebuff-web route status
codex-freebuff-web open cli
codex-freebuff-web open chat
codex-freebuff-web uninstall --yes
```

bridge 預設監聽 `127.0.0.1:17841`，Responses endpoint 在 `/v1`。可用
`--port`、`--cwd`、`--agent` 與 `--max-agent-steps` 調整 setup。

如果 credentials 不在預設位置，可在 setup 時指定：

```bash
codex-freebuff-web setup --credentials-path "/absolute/path/credentials.json" --cwd "$PWD"
```

`CODEBUFF_API_KEY` 與 `--api-key` 僅保留作舊設定相容 fallback；正常的 Freebuff free
流程不需要 API Key。

## 開發

只有從原始碼開發或自行 build 發行版時才需要 Bun：

```bash
bun run typecheck
bun test tests/freebuff.test.ts
bun run build
```

本專案位於 [Jakevin/codex-freebuff-web](https://github.com/Jakevin/codex-freebuff-web)。
目前 Freebuff 原始碼位於 [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff)。

## License

上游專案使用 MIT。Codebuff SDK 使用 Apache-2.0；請參閱
[LICENSES](LICENSES) 中的第三方聲明。
