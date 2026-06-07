#!/usr/bin/env bash
# Apply staysee.ru nginx config (gzip + SSL session cache). Keeps http2.
# Called from GitHub Actions after deploy-staysee, or manually on VPS.
set -euo pipefail

REPO_DIR="${STAYSEE_REPO_DIR:-$HOME/Staysee-app}"
CONF_SRC="$REPO_DIR/deploy/nginx/staysee.ru.conf"
CONF_DST="/etc/nginx/sites-available/staysee"

if [[ ! -f "$CONF_SRC" ]]; then
  echo "nginx config not found: $CONF_SRC" >&2
  exit 1
fi

sudo cp "$CONF_SRC" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/staysee
sudo nginx -t
sudo systemctl reload nginx
echo "nginx reloaded (http2 unchanged)"
