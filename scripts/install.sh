#!/bin/sh
set -eu

REPOSITORY="${CODEX_FREEBUFF_WEB_REPOSITORY:-Jakevin/codex-freebuff-web}"
VERSION="${CODEX_FREEBUFF_WEB_VERSION:-5.0.6}"
BIN_DIR="${CODEX_FREEBUFF_WEB_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${CODEX_FREEBUFF_WEB_LIB_DIR:-$HOME/.local/lib/codex-freebuff-web}"
DOC_DIR="${CODEX_FREEBUFF_WEB_DOC_DIR:-$HOME/.local/share/doc/codex-freebuff-web}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The runtime installer supports macOS only; use the runtime archive directly on Windows or Linux" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="codex-freebuff-web-darwin-$ARCH.tar.gz"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-freebuff-web.XXXXXX")"
STAGE_DIR="$LIB_DIR/.stage-$VERSION-$$"
TARGET_DIR="$LIB_DIR/$VERSION"
BACKUP_DIR="$LIB_DIR/.previous-$VERSION-$$"
trap 'rm -rf "$TEMP_DIR" "$STAGE_DIR"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/$ASSET" -o "$TEMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/checksums.txt" -o "$TEMP_DIR/checksums.txt"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{ print $1 }')"
if [ -z "$EXPECTED" ] || [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 verification failed for $ASSET" >&2
  exit 1
fi

for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  curl -fsSL "$BASE_URL/$DOC" -o "$TEMP_DIR/$DOC"
  DOC_EXPECTED="$(awk -v asset="$DOC" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
  DOC_ACTUAL="$(shasum -a 256 "$TEMP_DIR/$DOC" | awk '{ print $1 }')"
  if [ -z "$DOC_EXPECTED" ] || [ "$DOC_ACTUAL" != "$DOC_EXPECTED" ]; then
    echo "SHA-256 verification failed for $DOC" >&2
    exit 1
  fi
done

mkdir -p "$LIB_DIR" "$BIN_DIR" "$DOC_DIR"
mkdir "$STAGE_DIR"
tar -xzf "$TEMP_DIR/$ASSET" -C "$STAGE_DIR"
if [ ! -x "$STAGE_DIR/bin/codex-freebuff-web" ] || [ ! -x "$STAGE_DIR/runtime/bun" ]; then
  echo "Runtime archive is incomplete" >&2
  exit 1
fi
if [ "$("$STAGE_DIR/bin/codex-freebuff-web" --version)" != "$VERSION" ]; then
  echo "Runtime archive version does not match $VERSION" >&2
  exit 1
fi

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$TARGET_DIR"; then
  if [ -e "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$TARGET_DIR"; fi
  exit 1
fi

ln -sfn "$TARGET_DIR/bin/codex-freebuff-web" "$BIN_DIR/.codex-freebuff-web.next"
mv -f "$BIN_DIR/.codex-freebuff-web.next" "$BIN_DIR/codex-freebuff-web"
for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  install -m 0644 "$TEMP_DIR/$DOC" "$DOC_DIR/$DOC"
done
if [ -e "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi

echo "Installed $TARGET_DIR"
if [ "$#" -gt 0 ]; then
  "$TARGET_DIR/bin/codex-freebuff-web" setup "$@"
  echo "Next: $BIN_DIR/codex-freebuff-web login"
  exit 0
fi
echo "Next: $BIN_DIR/codex-freebuff-web setup --full --cwd \"$PWD\""
echo "Then: $BIN_DIR/codex-freebuff-web login"
