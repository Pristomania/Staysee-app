#!/usr/bin/env bash
# Apply staysee.ru nginx config (gzip + SSL session cache). Keeps http2.
# Resolves document root at apply time — never trust a hardcoded path blindly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${STAYSEE_REPO_DIR:-$HOME/Staysee-app}"
CONF_SRC="${STAYSEE_NGINX_SRC:-$SCRIPT_DIR/staysee.ru.conf}"
CONF_DST="${STAYSEE_NGINX_CONF:-/etc/nginx/sites-available/staysee}"
CONF_RENDERED="/tmp/staysee.ru.nginx.$$"

# Allow running from /tmp after CI scp (script next to conf).
if [[ ! -f "$CONF_SRC" && -f "$REPO_DIR/deploy/nginx/staysee.ru.conf" ]]; then
  CONF_SRC="$REPO_DIR/deploy/nginx/staysee.ru.conf"
  SCRIPT_DIR="$REPO_DIR/deploy/nginx"
fi

if [[ ! -f "$CONF_SRC" ]]; then
  echo "nginx config not found: $CONF_SRC" >&2
  exit 1
fi

# shellcheck source=resolve-web-root.sh
source "$SCRIPT_DIR/resolve-web-root.sh"

resolve_staysee_web_root
WEB_ROOT="$RESOLVED_WEB_ROOT"

if ! grep -q '@@STAYSEE_WEB_ROOT@@' "$CONF_SRC"; then
  echo "[nginx-preflight] WARN: template has no @@STAYSEE_WEB_ROOT@@ placeholder" >&2
fi

export STAYSEE_WEB_ROOT_RESOLVED="$WEB_ROOT"
perl -pe 's|\Q@@STAYSEE_WEB_ROOT@@\E|$ENV{STAYSEE_WEB_ROOT_RESOLVED}|g' "$CONF_SRC" > "$CONF_RENDERED"

echo ""
echo "Resolved nginx root:"
echo "$WEB_ROOT"
echo ""
echo "Source:"
echo "$RESOLVED_WEB_ROOT_SOURCE"
echo ""
echo "Generated config:"
grep -E '^\s*root\s+' "$CONF_RENDERED" | grep -v certbot | head -1
echo ""

sudo cp "$CONF_RENDERED" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/staysee
sudo nginx -t
sudo systemctl reload nginx
rm -f "$CONF_RENDERED"
echo "nginx reloaded (http2 unchanged)"
