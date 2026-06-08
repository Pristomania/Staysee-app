#!/usr/bin/env bash
# Apply staysee.ru nginx config (gzip + SSL session cache). Keeps http2.
# Resolves document root at apply time — never trust a hardcoded path blindly.
set -euo pipefail

PLACEHOLDER='@@STAYSEE_WEB_ROOT@@'
DRY_RUN=0

for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  fi
done

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

if [[ "$DRY_RUN" -eq 1 && -n "${STAYSEE_WEB_ROOT:-}" ]]; then
  RESOLVED_WEB_ROOT="$STAYSEE_WEB_ROOT"
  RESOLVED_WEB_ROOT_SOURCE="STAYSEE_WEB_ROOT (dry-run)"
  echo "[dry-run] using STAYSEE_WEB_ROOT without filesystem verify" >&2
else
  resolve_staysee_web_root
fi

WEB_ROOT="$RESOLVED_WEB_ROOT"

if [[ -z "$WEB_ROOT" ]]; then
  echo "[nginx-preflight] ERROR: resolved web root is empty" >&2
  exit 1
fi

if ! grep -qF "$PLACEHOLDER" "$CONF_SRC"; then
  echo "[nginx-preflight] WARN: template has no $PLACEHOLDER placeholder" >&2
fi

render_nginx_config() {
  local src="$1" dest="$2" root="$3"
  # Strip CR (CRLF templates break literal placeholder match). Use awk — no regex @ pitfalls.
  sed 's/\r$//' "$src" | awk -v placeholder="$PLACEHOLDER" -v root="$root" '
    {
      gsub(placeholder, root)
      print
    }
  ' > "$dest"
}

render_nginx_config "$CONF_SRC" "$CONF_RENDERED" "$WEB_ROOT"

if grep -qF "$PLACEHOLDER" "$CONF_RENDERED"; then
  echo "[nginx-preflight] ERROR: placeholder still present in generated config" >&2
  echo "[nginx-preflight] Generated config root lines:" >&2
  grep -E '^\s*root\s+' "$CONF_RENDERED" >&2 || true
  rm -f "$CONF_RENDERED"
  exit 1
fi

ROOT_LINE="$(grep -E '^\s*root\s+' "$CONF_RENDERED" | grep -v certbot | head -1 || true)"

echo ""
echo "Resolved nginx root:"
echo "$WEB_ROOT"
echo ""
echo "Source:"
echo "$RESOLVED_WEB_ROOT_SOURCE"
echo ""
echo "Generated config:"
echo "${ROOT_LINE:-<no root line found>}"
echo ""

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] OK — placeholder substituted, nginx not touched" >&2
  rm -f "$CONF_RENDERED"
  exit 0
fi

sudo cp "$CONF_RENDERED" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/staysee
sudo nginx -t
sudo systemctl reload nginx
rm -f "$CONF_RENDERED"
echo "nginx reloaded (http2 unchanged)"
