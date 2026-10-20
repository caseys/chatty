#!/usr/bin/env bash
# Test, build, back up the deployed copy, rsync dist/ to the server, and verify the live bundle.
# Overrides: DEPLOY_HOST, DEPLOY_PATH (remote dir holding chatty/), DEPLOY_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_HOST="${DEPLOY_HOST:-mudberry}"
DEPLOY_PATH="${DEPLOY_PATH:-www/www.mudberry.com/chatty/}"
DEPLOY_URL="${DEPLOY_URL:-https://www.mudberry.com/chatty/}"
DEPLOY_PATH="${DEPLOY_PATH%/}/"
SITE_DIR="${DEPLOY_PATH%chatty/}"   # the directory the backup tars chatty from
SITE_DIR="${SITE_DIR:-.}"

echo "==> Typecheck and tests"
npx tsc --noEmit && npx vitest run

echo "==> Build"
npm run build

echo "==> Back up the deployed copy"
ssh "$DEPLOY_HOST" "cd ~/$SITE_DIR && tar czf ~/chatty-deployed-backup-\$(date +%Y%m%d%H%M%S).tgz chatty"

echo "==> Upload"
rsync -az --delete --exclude .DS_Store dist/ "$DEPLOY_HOST:$DEPLOY_PATH"

echo "==> Verify"
local_bundle=$(grep -o '/chatty/assets/main-[^"]*\.js' dist/index.html | head -1 || true)
live_bundle=$(curl -s "$DEPLOY_URL" | grep -o '/chatty/assets/main-[^"]*\.js' | head -1 || true)
if [ -z "$local_bundle" ] || [ "$local_bundle" != "$live_bundle" ]; then
  echo "DEPLOY VERIFY FAILED: dist has '${local_bundle:-none}', live site serves '${live_bundle:-none}'" >&2
  exit 1
fi
echo "Deployed: $live_bundle"
