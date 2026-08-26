#!/usr/bin/env bash
# Wrangler wrapper.
#
# The tracked wrangler.toml carries REPLACE_ME placeholders so the repository
# can stay public without publishing anyone's project, chat or namespace ids.
# Your real values go in wrangler.local.toml, which is gitignored. This picks
# that file up when it exists and falls back to the tracked one when it doesn't,
# so a fresh clone still works.
#
#   ./scripts/wg.sh deploy
#   ./scripts/wg.sh secret put ANTHROPIC_API_KEY
set -euo pipefail
cd "$(dirname "$0")/.."
CFG=wrangler.toml
[ -f wrangler.local.toml ] && CFG=wrangler.local.toml
exec npx wrangler "$@" -c "$CFG"
