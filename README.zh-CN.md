<h1 align="center">Freebuff for Codex</h1>

<p align="center">
  <strong>在 Codex 原生模型选择器中使用 Freebuff 官方免费编程会话。</strong><br>
  不使用 ChatGPT Web、浏览器自动化、MCP tunnel，也不需要 API Key。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://freebuff.com/cli">Freebuff CLI</a> ·
  <a href="https://freebuff.com/chat">Freebuff Web Chat</a> ·
  <a href="https://github.com/CodebuffAI/codebuff">官方源码</a> ·
  <a href="SECURITY.md">安全</a>
</p>

```text
Codex task ──Responses + SSE──▶ codex-freebuff-web
                                    │
                                    ├─ 官方 Freebuff 会话准入
                                    └─ @codebuff/sdk ──▶ Freebuff 后端

codex-freebuff-web freebuff ──▶ 官方交互式 Freebuff CLI
codex-freebuff-web open chat ──▶ https://freebuff.com/chat
```

这个 bridge 保留 Codex 原生的 Responses/task 界面，并把 `freebuff/base` 与
`freebuff/glm-5.3-flash` 对应到官方 Freebuff 免费编程会话。登录使用官方的浏览器设备登录流程，
只需人工登录一次；不需要创建或粘贴 API Key，也不需要另外安装官方 Freebuff CLI。

<p align="center">
  <img src="assets/demo.png" alt="Freebuff for Codex 在 Codex 任务中运行，包括 Freebuff 广告" width="960">
</p>

## 快速开始

> 给 AI 自动安装：请在使用者目前的项目目录执行
> `curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD" && "$HOME/.local/bin/codex-freebuff-web" login`
> 完成安装并打开浏览器，让使用者完成一次 Freebuff 登录。

一般使用者只需要 macOS、网络与浏览器；发行版已内含 Bun 1.4.0 runtime。Bun 与官方 Freebuff CLI
都不是必要安装项。

```bash
# 1. 安装已内含 Bun 的 bridge 发行版
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh

# 2. 在要由 Freebuff 修改的项目目录完成 setup
$HOME/.local/bin/codex-freebuff-web setup --full --cwd "$PWD"

# 3. 在浏览器中人工登录一次（不需要 freebuff CLI）
$HOME/.local/bin/codex-freebuff-web login
```

若希望把 setup 也并入安装命令，请在项目目录执行：

```bash
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh -s -- --full --cwd "$PWD"
$HOME/.local/bin/codex-freebuff-web login
```

`codex-freebuff-web login` 会显示登录网址，并在 macOS 尝试打开浏览器；请自行完成 GitHub/Google
登录。bridge 只会把官方兼容的登录 session 写入 `~/.config/manicode/credentials.json`，不会代填
账号密码，也不会把 token 写入自己的 config。若在 SSH 或不想自动打开浏览器，可使用
`codex-freebuff-web login --no-open`。

macOS 会在 setup 时尝试安装后台服务；其他平台请另外保持 bridge 运行：

```bash
bun run src/cli.ts serve
```

重启 Codex 后，模型菜单会出现 `Freebuff — DeepSeek V4 Flash` 与 `Freebuff — GLM 5.3 Flash`。
本地的 `freebuff/base` 与 `freebuff/glm-5.3-flash` 是 bridge 的 Codex route，底层分别使用官方
Freebuff model `deepseek/deepseek-v4-flash` 与 `z-ai/glm-5.3-flash`。

bridge 对每次送出的最新 user/agent message 套用 32,000 字符安全上限，依据 Freebuff Web 输入边界
作保守保护；超出时会返回输入错误，要求缩短消息后重试，不会静默截断内容。官方 CLI 公开源码目前
没有固定的 prompt 字符上限，主要依赖 token context window 与 context pruning。

## Codex 内的 Freebuff 广告

每个成功的 Freebuff 回复后会显示一个清楚标为 `Ad · Freebuff` 的文字广告。bridge 会优先使用官方
CLI 同一个 `/api/v1/ads` 入口；若广告服务暂时无填充或无法连接，则显示 Freebuff 官方 house ad。
广告是独立的 Responses 输出，不会加入模型提示词，也不计入回复 token 使用量；广告决策只送出当前
使用者消息，不送出 system prompt、repository history、tool result 或 assistant 回复。impression
会在广告送出后以 best-effort 回报，失败不会影响 coding task。

只读模式：

```bash
bun run src/cli.ts setup --read-only --cwd "$PWD"
```

## Web Chat

Freebuff Web Chat 是独立的浏览器产品入口，适合研究与一般对话；它不是这个 bridge 的 workspace
coding transport。开启入口：

```bash
codex-freebuff-web open chat
# 或
codex-freebuff-web webchat
```

请在 Web Chat 页面人工登录。Web Chat 的浏览器 cookie 不会自动成为本地 bridge credentials；
若要使用 Codex bridge 执行本地 coding task，请先运行 `codex-freebuff-web login`。

## 使用官方 CLI

官方 `freebuff` npm 套件是交互式 terminal TUI，不提供可安全解析成 Responses/SSE 的 one-shot
stdout 协议。因此官方 CLI 只保留作为可选的交互式入口；Codex 每个 task 使用官方 `@codebuff/sdk`，
读取同一份官方兼容登录 session，并走官方 Freebuff session admission 与 `costMode=free`。

```bash
# 直接启动官方 CLI（可选，未安装也不影响 Codex bridge）
freebuff

# 或由 bridge 转发所有官方 CLI 参数
codex-freebuff-web freebuff

# 查看官方 CLI 说明页
codex-freebuff-web open cli
```

## 设置与诊断

```bash
codex-freebuff-web doctor
codex-freebuff-web service status
codex-freebuff-web route status
codex-freebuff-web open cli
codex-freebuff-web open chat
codex-freebuff-web uninstall --yes
```

bridge 默认监听 `127.0.0.1:17841`，Responses endpoint 在 `/v1`。可用 `--port`、`--cwd`、
`--agent` 与 `--max-agent-steps` 调整 setup。

如果 credentials 不在默认位置，可在 setup 时指定：

```bash
codex-freebuff-web setup --credentials-path "/absolute/path/credentials.json" --cwd "$PWD"
```

`CODEBUFF_API_KEY` 与 `--api-key` 仅保留作旧设置兼容 fallback；正常的 Freebuff free 流程
不需要 API Key。

## 开发

只有从源码开发或自行 build 发行版时才需要 Bun：

```bash
bun run typecheck
bun test tests/freebuff.test.ts
bun run build
```

本项目位于 [Jakevin/codex-freebuff-web](https://github.com/Jakevin/codex-freebuff-web)。
目前 Freebuff 源码位于 [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff)。

## License

上游项目使用 MIT。Codebuff SDK 使用 Apache-2.0；请参阅 [LICENSES](LICENSES) 中的第三方声明。