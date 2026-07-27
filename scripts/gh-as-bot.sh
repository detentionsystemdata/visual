#!/usr/bin/env bash
# Run a `gh` command authenticated as the bot, never the operator's own logged-in
# session. `git push` already goes through the bot because the remote URL and
# credential helper are pinned to it — but `gh release`/`gh api` calls ignore
# that entirely and fall back to whatever account `gh auth login` last set,
# which is a real leak vector distinct from git push. Use this for every `gh`
# call that touches GitHub state on this repo instead of calling `gh` directly.
#
# Usage: scripts/gh-as-bot.sh api repos/detentionsystemdata/visual/pages
set -euo pipefail
BOT_TOKEN=$(git credential-osxkeychain get <<<$'protocol=https\nhost=github.com\nusername=detention-system-data-bot\n' | grep '^password=' | cut -d= -f2)
if [ -z "$BOT_TOKEN" ]; then
  echo "gh-as-bot: no bot token in the keychain — refusing to fall back to the default gh session" >&2
  exit 1
fi
exec env GH_TOKEN="$BOT_TOKEN" gh "$@"
