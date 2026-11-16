#!/usr/bin/env bash
# Temporary, isolated site reachability test; never modifies the production vhost or app root.
set -euo pipefail
umask 077
domain=staysee.online
conf=/etc/nginx/conf.d/staysee-online-probe.conf
backup=/etc/nginx/conf.d/staysee-online-probe.original
base=/var/www/staysee-online-preview-v2
verifier=${1:?missing verifier}
[[ "$EUID" == 0 && "$verifier" =~ ^\{SHA\}[A-Za-z0-9+/]{27}=$ ]]
exec 9>/run/lock/staysee-online-preview.lock
flock -n 9
nginx -t
[[ -f "$conf" && ! -L "$conf" && ! -e "$base" ]]
if [[ -e "$backup" ]]; then
    [[ -f "$backup" && ! -L "$backup" ]] && cmp -s "$conf" "$backup"
fi
grep -Fq 'server_name staysee.online;' "$conf"
grep -Fq 'return 200 "Reachability OK"' "$conf"
grep -Fq 'location / { return 404; }' "$conf"
[[ $(grep -cE '^[[:space:]]*server_name[[:space:]]' "$conf") == 2 ]]
[[ $(grep -cE '^[[:space:]]*listen.*443' "$conf") == 2 ]]

online=(curl --noproxy '*' --silent --show-error --max-time 8 --resolve "$domain:443:127.0.0.1")
before=$("${online[@]}" -o /dev/null -w '%{http_code}' "https://$domain/")
[[ "$before" == 404 ]]
prod=(curl --noproxy '*' --silent --show-error --max-time 8 --resolve 'staysee.ru:443:127.0.0.1')
prod_before=$("${prod[@]}" --fail 'https://staysee.ru/' | sha256sum | cut -d' ' -f1)

live=$(nginx -T 2>/dev/null | awk '
  /^# configuration file / { stanza=0 }
  /server_name[[:space:]]+staysee\.ru([[:space:];]|$)/ { stanza=1 }
  stanza && /^[[:space:]]*root[[:space:]]/ && $2 !~ /certbot/ { gsub(/;$/, "", $2); print $2; stanza=0 }
' | sort -u)
[[ "$live" =~ ^/[A-Za-z0-9_./-]+$ && -s "$live/index.html" && -d "$live/assets" ]]
[[ "$(realpath "$live")" != "$base" ]]
install -d -m 0755 "$base" "$base/app" "$base/gate"
cp -a -- "$live/." "$base/app/"
chmod 0755 "$base/app"
python3 - "$base/app" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
old = b'https://staysee.ru/supabase'
new = b'https://staysee.online/supabase'
changed = 0
for p in root.rglob('*'):
    if p.is_symlink():
        raise SystemExit('Unexpected symlink in preview copy')
    if p.suffix not in ('.js', '.html') or not p.is_file():
        continue
    original = p.read_bytes()
    if old in original:
        p.write_bytes(original.replace(old, new))
        changed += 1
if not changed:
    raise SystemExit('Cannot identify the compiled API endpoint; no switch made')
print(f'Preview API address updated in {changed} copied files')
PY

printf 'preview:%s\n' "$verifier" > "$base/gate/htpasswd"
chown root:www-data "$base/gate/htpasswd"
chmod 0640 "$base/gate/htpasswd"
printf '<!doctype html><meta charset="utf-8"><title>Тест Стэйси</title><a href="/">Открыть тестовую Стэйси</a>\n' > "$base/gate/access.html"
chmod 0644 "$base/gate/access.html"
session=$(openssl rand -hex 32)
tmp=$(mktemp /etc/nginx/conf.d/.staysee-preview.XXXXXX)
trap 'test ! -e "$tmp" || unlink "$tmp"' EXIT

cat > "$tmp" <<'CONF'
server {
    listen 80;
    listen [::]:80;
    server_name staysee.online;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
    location = /healthz { default_type text/plain; return 200 "Reachability OK"; }
    location / { return 301 https://staysee.online$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name staysee.online;
    ssl_certificate /etc/letsencrypt/live/staysee.online/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/staysee.online/privkey.pem;
    root /var/www/staysee-online-preview/app;
    index index.html;
    resolver 127.0.0.53 valid=30s;
    resolver_timeout 5s;
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;

    location = /healthz { default_type text/plain; return 200 "Reachability OK"; }
    location = /_preview/access {
        auth_basic "StaySee test";
        auth_basic_user_file /var/www/staysee-online-preview/gate/htpasswd;
        alias /var/www/staysee-online-preview/gate/access.html;
        default_type text/html;
        add_header Set-Cookie "st_preview=@@SESSION@@; Path=/; Max-Age=21600; Secure; HttpOnly; SameSite=Strict";
        add_header Cache-Control "private, no-store" always;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }
    location = / {
        if ($cookie_st_preview != "@@SESSION@@") { return 302 /_preview/access; }
        try_files /index.html =404;
    }
    location / {
        if ($cookie_st_preview != "@@SESSION@@") { return 403; }
        try_files $uri $uri/ /index.html;
    }
    location ~* ^/supabase/auth/v1/(signup|invite|recover|resend)(/|$) { return 403; }
    location /supabase/ {
        if ($cookie_st_preview != "@@SESSION@@") { return 403; }
        set $supabase_origin https://jnxrildlwvtxhtiwucbt.supabase.co;
        rewrite ^/supabase/(.*)$ /$1 break;
        proxy_pass $supabase_origin;
        proxy_ssl_server_name on;
        proxy_ssl_name jnxrildlwvtxhtiwucbt.supabase.co;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_set_header Host jnxrildlwvtxhtiwucbt.supabase.co;
        proxy_set_header Cookie "";
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_connect_timeout 15s;
        client_max_body_size 4m;
    }
}
CONF
sed -i "s/@@SESSION@@/$session/g;s|/var/www/staysee-online-preview/|$base/|g" "$tmp"
if [[ ! -e "$backup" ]]; then cp -p -- "$conf" "$backup"; fi

verify() {
    local url="https://$domain" code
    [[ $("${online[@]}" --fail "$url/healthz") == 'Reachability OK' ]] || { echo 'probe body mismatch'; return 1; }
    check_code gate 401 "$url/_preview/access" || return 1
    check_code unlocked-redirect 302 "$url/" || return 1
    check_code locked-api 403 "$url/supabase/auth/v1/health" || return 1
    check_code unlocked-app 200 -b "st_preview=$session" "$url/" || return 1
    check_code signup 403 -b "st_preview=$session" -X POST "$url/supabase/auth/v1/signup" || return 1
    code=$("${online[@]}" -b "st_preview=$session" -o /dev/null -w '%{http_code}' "$url/supabase/auth/v1/health") || return 1
    [[ "$code" == 401 || "$code" == 200 ]] || { echo "Supabase health HTTP=$code"; return 1; }
    [[ $("${prod[@]}" --fail 'https://staysee.ru/' | sha256sum | cut -d' ' -f1) == "$prod_before" ]] || { echo 'Production HTML hash changed'; return 1; }
}
check_code() {
    local label=$1 expected=$2 code
    shift 2
    code=$("${online[@]}" -o /dev/null -w '%{http_code}' "$@") || return 1
    [[ "$code" == "$expected" ]] || { echo "$label HTTP=$code expected=$expected"; return 1; }
}
wait_for_preview() {
    for attempt in 1 2 3; do
        sleep 1
        if verify; then return 0; fi
    done
    return 1
}
if ! install -m 0600 "$tmp" "$conf" || ! nginx -t || ! systemctl reload nginx || ! wait_for_preview; then
    install -m 0644 "$backup" "$conf"
    nginx -t && systemctl reload nginx
    echo 'Preview verification failed; original vhost restored' >&2
    exit 1
fi
echo 'PREVIEW_VERIFIED: probe 200, gate 401, authenticated SPA 200, signup blocked, Supabase health reached, production HTML unchanged'
