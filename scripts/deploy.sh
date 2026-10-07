#!/usr/bin/env bash
# Deploy site/ to the gh-pages branch (GitHub Pages).
# Usage: pnpm deploy   (builds first, then force-syncs site/ -> gh-pages)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/data/home/.npm-global/bin:$PATH"
cd "$ROOT"
pnpm build

TMP="$ROOT/.ghpages"
rm -rf "$TMP"; mkdir -p "$TMP"
if git show-ref --verify --quiet refs/heads/gh-pages; then
  git clone --quiet --no-hardlinks . "$TMP"
  git -C "$TMP" checkout --quiet gh-pages
else
  git clone --quiet --no-hardlinks . "$TMP"
  git -C "$TMP" checkout --quiet --orphan gh-pages
  git -C "$TMP" rm -rf --quiet . 2>/dev/null || true
fi
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r "$ROOT/site/"* "$TMP"/
cd "$TMP"
git add -A
git -c user.name="dw" -c user.email="spencery145@gmail.com" commit --quiet -m "deploy: $(date -u +%FT%TZ)" || true
git push --quiet origin gh-pages
rm -rf "$TMP"
echo "deployed -> https://driftwintergames.github.io/ad-game-clones/"
