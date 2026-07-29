#!/usr/bin/env bash
# Isolated DNS-failure proof + production apply of runtime-DNS nginx config.
# Invoked from CI after scp of deploy/nginx/* to the VPS.
set -euo pipefail

NGINX_SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$NGINX_SCRIPTS"/*.sh
sed -i 's/\r$//' "$NGINX_SCRIPTS"/*.sh "$NGINX_SCRIPTS"/*.conf 2>/dev/null || true

TS="$(date +%s)"
BAK="/etc/nginx/sites-enabled/staysee.bak.${TS}"
WEB_ROOT="${STAYSEE_WEB_ROOT_OVERRIDE:-/var/www/Staysee-app/dist}"
RENDERED="/tmp/staysee.proposed.${TS}.conf"
ISO_PREFIX="/tmp/nginx-dns-iso-${TS}"
REPORT="/tmp/nginx-dns-hardening-result.${TS}.txt"

exec > >(tee -a "$REPORT") 2>&1

echo "===== locate deploy-staysee ====="
type deploy-staysee || true
command -v deploy-staysee || true
DS_BIN="$(command -v deploy-staysee 2>/dev/null || true)"
if [[ -n "$DS_BIN" ]]; then
  ls -la "$DS_BIN" || true
  grep -nE 'nginx|systemctl|reload' "$DS_BIN" 2>/dev/null | head -n 40 || true
fi

echo "===== render proposed production config ====="
export STAYSEE_NGINX_SRC="$NGINX_SCRIPTS/staysee.ru.conf"
# Dry-run validates placeholder substitution when root is forced.
STAYSEE_WEB_ROOT="$WEB_ROOT" bash "$NGINX_SCRIPTS/apply-on-vps.sh" --dry-run
sed 's/\r$//' "$NGINX_SCRIPTS/staysee.ru.conf" | sed "s|@@STAYSEE_WEB_ROOT@@|${WEB_ROOT}|g" > "$RENDERED"
echo "----- proposed /supabase/ block -----"
sed -n '/location \/supabase\//,/^    }/p' "$RENDERED"

echo "===== PRE: backup live config ====="
sudo cp -a /etc/nginx/sites-enabled/staysee "$BAK"
echo "backup=$BAK"
# If sites-enabled is a symlink, also keep sites-available content recoverable.
if [[ -L /etc/nginx/sites-enabled/staysee ]]; then
  sudo cp -a /etc/nginx/sites-available/staysee "/etc/nginx/sites-available/staysee.bak.${TS}"
fi

echo "===== ISOLATED DNS-FAILURE nginx (port 18080) ====="
mkdir -p "$ISO_PREFIX"/{logs,html,conf}
printf '%s\n' '<!doctype html><title>iso-ok</title>iso-static-ok' > "$ISO_PREFIX/html/index.html"

# Write isolated conf without relying on nested CI heredocs.
python3 - "$ISO_PREFIX" <<'PY'
import sys
from pathlib import Path

p = Path(sys.argv[1])
conf = f"""worker_processes 1;
error_log {p}/logs/error.log;
pid {p}/nginx.pid;
events {{ worker_connections 64; }}
http {{
  access_log {p}/logs/access.log;
  resolver 127.0.0.53 valid=30s;
  resolver_timeout 5s;
  server {{
    listen 127.0.0.1:18080;
    server_name localhost;
    root {p}/html;
    index index.html;
    location / {{
      try_files $uri /index.html;
    }}
    location /supabase/ {{
      set $supabase_origin https://this-host-must-not-resolve.invalid;
      rewrite ^/supabase/(.*)$ /$1 break;
      proxy_pass $supabase_origin;
      proxy_ssl_server_name on;
      proxy_ssl_name this-host-must-not-resolve.invalid;
      proxy_connect_timeout 3s;
      proxy_read_timeout 3s;
    }}
  }}
}}
"""
out = p / "conf" / "nginx.conf"
out.write_text(conf)
print("iso_conf_bytes", out.stat().st_size)
PY

# Must pass despite unresolvable upstream hostname (runtime DNS via variable).
nginx -t -c "$ISO_PREFIX/conf/nginx.conf" -p "$ISO_PREFIX/"
nginx -c "$ISO_PREFIX/conf/nginx.conf" -p "$ISO_PREFIX/"
sleep 1

echo "iso static:"
curl -sS -D- --max-time 5 "http://127.0.0.1:18080/" | head -n 20

echo "iso proxy (expect 502/504):"
set +e
ISO_CODE="$(curl -sS -o /tmp/iso-proxy.body -w '%{http_code}' --max-time 8 "http://127.0.0.1:18080/supabase/rest/v1/")"
set -e
echo "iso_proxy_http=$ISO_CODE"
head -n 5 /tmp/iso-proxy.body || true
case "$ISO_CODE" in
  502|504) echo "iso_proxy_status=expected_gateway_error" ;;
  *)
    echo "ERROR: isolated proxy expected 502/504, got $ISO_CODE" >&2
    nginx -s stop -c "$ISO_PREFIX/conf/nginx.conf" -p "$ISO_PREFIX/" || true
    exit 1
    ;;
esac

kill -0 "$(cat "$ISO_PREFIX/nginx.pid")"
echo "iso_pid_alive=yes"
nginx -s stop -c "$ISO_PREFIX/conf/nginx.conf" -p "$ISO_PREFIX/" || true
echo "ISOLATED_DNS_FAILURE_TEST=PASS"

echo "===== PRODUCTION config install + nginx -t ====="
sudo cp "$RENDERED" /etc/nginx/sites-available/staysee
sudo ln -sf /etc/nginx/sites-available/staysee /etc/nginx/sites-enabled/staysee
if ! sudo nginx -t; then
  echo "nginx -t FAILED - restoring backup"
  if [[ -L /etc/nginx/sites-enabled/staysee ]]; then
    sudo cp -a "/etc/nginx/sites-available/staysee.bak.${TS}" /etc/nginx/sites-available/staysee
  else
    sudo cp -a "$BAK" /etc/nginx/sites-enabled/staysee
  fi
  sudo nginx -t || true
  exit 1
fi

echo "===== reload-or-start production nginx ====="
bash "$NGINX_SCRIPTS/reload-or-start-nginx.sh"
systemctl is-active nginx
ss -lptn | grep -E ':80|:443' || true

echo "===== functional checks ====="
curl -sS -I --max-time 15 https://staysee.ru | head -n 15
curl -sS -I --max-time 15 https://www.staysee.ru | head -n 15
curl -sS --max-time 15 https://staysee.ru/ | head -c 200; echo

curl -sS -D- --max-time 20 -o /tmp/proxy.body \
  -H 'apikey: invalid' \
  -H 'Authorization: Bearer invalid' \
  "https://staysee.ru/supabase/rest/v1/" | head -n 25
head -c 300 /tmp/proxy.body; echo

curl -sS -o /tmp/proxy-q.body -w "proxy_qs_http=%{http_code}\n" --max-time 20 \
  "https://staysee.ru/supabase/auth/v1/health?x=1"
head -c 200 /tmp/proxy-q.body; echo

# Confirm live config uses runtime DNS (variable), not literal upstream at parse time.
if grep -n 'set \$supabase_origin' /etc/nginx/sites-enabled/staysee >/dev/null \
  && grep -n 'resolver 127.0.0.53 valid=30s' /etc/nginx/sites-enabled/staysee >/dev/null; then
  echo "live_config_runtime_dns=yes"
else
  echo "ERROR: live config missing runtime DNS markers" >&2
  exit 1
fi

echo "===== controlled restart ====="
sudo systemctl restart nginx
systemctl is-active nginx
systemctl is-enabled nginx
ss -lptn | grep -E ':80|:443' || true
curl -sS -o /dev/null -w "after_restart_staysee=%{http_code}\n" --max-time 15 https://staysee.ru
curl -sS -o /dev/null -w "after_restart_www=%{http_code}\n" --max-time 15 https://www.staysee.ru
curl -sS -o /dev/null -w "after_restart_proxy=%{http_code}\n" --max-time 20 \
  -H 'apikey: invalid' -H 'Authorization: Bearer invalid' \
  "https://staysee.ru/supabase/rest/v1/"

echo "===== recent nginx errors ====="
sudo journalctl -u nginx -n 30 --no-pager || true
sudo tail -n 30 /var/log/nginx/error.log || true

echo "===== DONE APPLY ====="
echo "backup=$BAK"
echo "report=$REPORT"
echo "NGINX_DNS_HARDENING_APPLY=PASS"
