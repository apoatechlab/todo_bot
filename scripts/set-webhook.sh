#!/usr/bin/env bash
# Register the Telegram webhook with the same secret the Worker checks.
#
#   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
#   ./scripts/set-webhook.sh https://family-todo-bot.<sub>.workers.dev
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"
: "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET (openssl rand -hex 32)}"
URL="${1:?usage: set-webhook.sh <worker-url>}"

curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${URL}\",
       \"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET}\",
       \"allowed_updates\":[\"message\"],
       \"drop_pending_updates\":true}"
echo
