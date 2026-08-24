#!/usr/bin/env bash
# Show webhook status. `last_error_message` is the first place to look when the
# bot goes quiet.
set -euo pipefail
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
echo
