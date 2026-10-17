#!/bin/sh
# Loads the App's id, webhook secret and private key from register-app.mjs's
# output into the deployed Worker as secrets, without printing them.
#   scripts/set-secrets.sh <app.json>
set -eu
APP="${1:?usage: scripts/set-secrets.sh <app.json>}"
test -s "$APP"
cd "$(dirname "$0")/.."
umask 077
BULK="$(mktemp)"
trap 'rm -f "$BULK"' EXIT
node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const k of ["id", "webhook_secret", "pem"]) if (a[k] === undefined) { console.error("missing " + k); process.exit(1); }
process.stdout.write(JSON.stringify({ GITHUB_APP_ID: String(a.id), GITHUB_WEBHOOK_SECRET: a.webhook_secret, GITHUB_PRIVATE_KEY: a.pem }));
' "$APP" > "$BULK"
pnpm exec wrangler secret bulk "$BULK"
