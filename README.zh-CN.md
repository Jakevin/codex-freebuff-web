# Freebuff for Codex

本分支使用 Freebuff 官方的浏览器设备登录 session，不使用 ChatGPT Web、浏览器自动化、MCP
tunnel，也不要求 API Key。一般使用者不需要安装 Bun 或官方 Freebuff CLI：

发行版已经内含 Bun 1.4.0 runtime。

```bash
# 安装已内含 Bun 的 bridge 发行版
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh

# 在项目目录设置并进行一次浏览器登录
$HOME/.local/bin/codex-freebuff-web setup --full --cwd "$PWD"
$HOME/.local/bin/codex-freebuff-web login
```

`codex-freebuff-web login` 会显示登录网址，并在 macOS 尝试打开浏览器。完成登录后，bridge
会将官方兼容 credentials 保存到 `~/.config/manicode/credentials.json`。

bridge 对每次送出的最新 user/agent message 套用 32,000 字符安全上限，依据 Freebuff Web
输入边界作保守保护；超出时会要求缩短消息后重试，不会静默截断内容。官方 CLI 公开源码目前
没有固定的 prompt 字符上限，主要依赖 token context window 与 context pruning。

Web Chat 是独立的网页入口：

```bash
codex-freebuff-web open chat
# 或
codex-freebuff-web webchat
```

Web Chat 的浏览器 cookie 不会自动成为本地 bridge credentials；Codex 本地 coding task 仍需先运行
`codex-freebuff-web login`。详细说明请参阅 [README.md](README.md)。
