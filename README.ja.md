# Freebuff for Codex

このブランチは、元の ChatGPT Web ブラウザアダプターを公式 Freebuff の無料セッションと
`@codebuff/sdk` に置き換えています。ChatGPT Web、ブラウザ自動化、MCP tunnel、API Key は使用しません。

配布版には Bun runtime が含まれているため、通常の利用者は Bun や公式 CLI を別途インストールする必要はありません。

```bash
curl -fsSL https://raw.githubusercontent.com/Jakevin/codex-freebuff-web/main/scripts/install.sh | sh
$HOME/.local/bin/codex-freebuff-web setup --full --cwd "$PWD"
$HOME/.local/bin/codex-freebuff-web login
```

`codex-freebuff-web login` で公式互換のブラウザログインを一度完了します。Web Chat は `codex-freebuff-web open chat` で開けます。詳細は
[README.md](README.md) を参照してください。既定のモデルは `freebuff/base` です。
