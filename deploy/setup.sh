#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the self-hosted notification service.
# Generates secrets and VAPID keys, prompts for the essentials, writes .env,
# then reminds you to build and run migrations/seed.

cd "$(dirname "$0")"

if [ -f .env ]; then
  echo ".env already exists — refusing to overwrite. Delete it first to re-run."
  exit 1
fi

command -v npx >/dev/null 2>&1 || { echo "Node.js/npx is required to generate VAPID keys."; exit 1; }

echo "== Notification service setup =="
read -rp "Public domain (e.g. notify.example.com): " APP_DOMAIN
read -rp "Admin username [admin]: " ADMIN_NAME
ADMIN_NAME=${ADMIN_NAME:-admin}
read -rsp "Admin password: " ADMIN_PASSWORD; echo
read -rp "VAPID contact email [admin@${APP_DOMAIN}]: " VAPID_EMAIL
VAPID_EMAIL=${VAPID_EMAIL:-admin@${APP_DOMAIN}}

# Quiet hours are evaluated in the server's local time, so this must be right.
# TZ must be an IANA tz database name ("Area/Location"), e.g. Europe/Helsinki.
# Abbreviations (EET) and offsets (GMT+2, +02:00) are rejected: an offset cannot
# express daylight saving time.
DEFAULT_TZ=$(timedatectl show --property=Timezone --value 2>/dev/null \
  || cat /etc/timezone 2>/dev/null \
  || echo "UTC")
while true; do
  echo "Timezone for quiet hours. Use an IANA name like 'Europe/Helsinki' (not 'EET' or '+02:00')."
  read -rp "Timezone [${DEFAULT_TZ}]: " APP_TZ
  APP_TZ=${APP_TZ:-$DEFAULT_TZ}
  if [ "$APP_TZ" = "UTC" ] || [ -f "/usr/share/zoneinfo/$APP_TZ" ]; then
    break
  fi
  echo "  '${APP_TZ}' is not a known timezone. See: timedatectl list-timezones"
done

# SMS is the only channel that breaks through a silenced iPhone (Emergency
# Bypass on a contact). Two ways to get it.
echo
echo "SMS channel for critical alerts:"
echo "  1) MikroTik router's LTE modem  (no monthly fee; needs a WireGuard tunnel)"
echo "  2) Twilio                        (per message + monthly fee per number)"
echo "  3) None"
read -rp "Choose [1/2/3]: " SMS_CHOICE

SMS_PROVIDER=none
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
TWILIO_FROM_NUMBER=""
MIKROTIK_URL=""
MIKROTIK_USER=""
MIKROTIK_PASSWORD=""
MIKROTIK_SMS_PORT="lte1"

case "$SMS_CHOICE" in
  1)
    SMS_PROVIDER=mikrotik
    echo "  See docs/MIKROTIK_SMS.md to set up the WireGuard tunnel first."
    read -rp "  Router address on the tunnel [http://10.10.10.2]: " MIKROTIK_URL
    MIKROTIK_URL=${MIKROTIK_URL:-http://10.10.10.2}
    read -rp "  RouterOS username [notify-sms]: " MIKROTIK_USER
    MIKROTIK_USER=${MIKROTIK_USER:-notify-sms}
    read -rsp "  RouterOS password: " MIKROTIK_PASSWORD; echo
    read -rp "  Modem interface [lte1]: " MIKROTIK_SMS_PORT
    MIKROTIK_SMS_PORT=${MIKROTIK_SMS_PORT:-lte1}
    ;;
  2)
    SMS_PROVIDER=twilio
    read -rp "  Twilio Account SID: " TWILIO_ACCOUNT_SID
    read -rp "  Twilio Auth Token: " TWILIO_AUTH_TOKEN
    read -rp "  Twilio From number (E.164, e.g. +358...): " TWILIO_FROM_NUMBER
    ;;
esac

echo "Generating VAPID keys..."
VAPID_JSON=$(npx --yes web-push generate-vapid-keys --json)
VAPID_PUBLIC_KEY=$(echo "$VAPID_JSON" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
VAPID_PRIVATE_KEY=$(echo "$VAPID_JSON" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)

SESSION_SECRET=$(openssl rand -hex 32)
WEBHOOK_SIGNING_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)

cat > .env <<EOF
NODE_ENV=production
PORT=3000
APP_URL=https://${APP_DOMAIN}
APP_DOMAIN=${APP_DOMAIN}
TENANT_NAME=Home
TZ=${APP_TZ}

DATABASE_URL=postgres://notify:${POSTGRES_PASSWORD}@postgres:5432/notify
REDIS_URL=redis://redis:6379
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_SUBJECT=mailto:${VAPID_EMAIL}

SMS_PROVIDER=${SMS_PROVIDER}

MIKROTIK_URL=${MIKROTIK_URL}
MIKROTIK_USER=${MIKROTIK_USER}
MIKROTIK_PASSWORD=${MIKROTIK_PASSWORD}
MIKROTIK_SMS_PORT=${MIKROTIK_SMS_PORT}
MIKROTIK_CA_CERT=

TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}
TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER}

MQTT_ENABLED=false
MQTT_URL=mqtt://broker:1883
MQTT_TOPIC_PREFIX=notify/

SESSION_SECRET=${SESSION_SECRET}
WEBHOOK_SIGNING_SECRET=${WEBHOOK_SIGNING_SECRET}
ACK_TOKEN_TTL_SECONDS=3600
DEDUP_COOLDOWN_SECONDS=300

ADMIN_NAME=${ADMIN_NAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF

chmod 600 .env
echo
echo ".env written."
echo
echo "Next steps:"
echo "  1. Build & start:   podman-compose up -d --build   (or: docker compose up -d --build)"
echo "  2. Run migrations & seed (creates admin + prints an API key):"
echo "       podman-compose exec server node dist/db/seed.js"
echo "  3. Open https://${APP_DOMAIN} and sign in as '${ADMIN_NAME}'."
echo
echo "Save the API key printed by the seed step — it is shown only once."
echo "(You can also create and rotate your own keys later in Settings -> API keys.)"
echo
echo "Your action-webhook signing secret (share with Home Assistant to verify calls):"
echo "  ${WEBHOOK_SIGNING_SECRET}"
