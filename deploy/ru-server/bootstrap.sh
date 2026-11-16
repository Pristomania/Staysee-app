#!/usr/bin/env bash
# StaySee: one-time preparation of a NEW server (Ubuntu 22.04 or 24.04) for the site staysee.ru.
#
# Run once as root (the provider's web console is fine), passing the PUBLIC key that GitHub Actions
# will use to upload the site:
#
#   bash bootstrap.sh "ssh-ed25519 AAAA... staysee-deploy"
#
# Safe to run again. It installs nginx and certbot, creates the limited user "deploy", prepares the folders,
# and installs two small helper commands. It does not touch SSH settings, does not install any VPN,
# and does not request a certificate (that is a separate step, after DNS points here).
set -euo pipefail

PUBKEY="${1:-}"
[ "$(id -u)" -eq 0 ] || { echo "Запустите от root."; exit 1; }
[ -n "$PUBKEY" ] || { echo "Первым аргументом нужен ПУБЛИЧНЫЙ ключ выкладки (строка ssh-ed25519 ...)."; exit 1; }
case "$PUBKEY" in
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;;
  *) echo "Это не похоже на публичный ключ."; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot rsync ufw curl unattended-upgrades

# 1. The limited user the deploy logs in as. It owns only the site folder.
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
printf '%s\n' "$PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# 2. Folders. The voice-dictation model lives outside the deploy folder and is uploaded separately.
install -d -m 755 -o deploy -g www-data /var/www/Staysee-app /var/www/Staysee-app/dist
install -d -m 755 /var/www/certbot /var/www/staysee-voice-model
install -d -m 755 -o deploy -g deploy /home/deploy/incoming

# 3. Helper: apply the nginx config that the deploy uploaded. Runs as root, takes no arguments.
cat > /usr/local/bin/staysee-apply-nginx <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
SRC=/home/deploy/incoming/staysee.ru.conf
DST=/etc/nginx/sites-available/staysee
ROOT=/var/www/Staysee-app/dist
[ -f "$SRC" ] || { echo "Нет файла $SRC"; exit 1; }
[ -f "$ROOT/index.html" ] || { echo "В $ROOT нет index.html"; exit 1; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
sed 's/\r$//' "$SRC" | sed "s|@@STAYSEE_WEB_ROOT@@|$ROOT|g" > "$tmp"
if [ ! -f /etc/letsencrypt/live/staysee.ru/fullchain.pem ]; then
  echo "СЕРТИФИКАТА ЕЩЁ НЕТ: включён временный режим только по HTTP (нужен для выпуска сертификата)."
  cat > "$tmp" <<HTTP
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name staysee.ru www.staysee.ru _;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { root $ROOT; try_files \$uri /index.html; }
}
HTTP
fi
backup=""
if [ -f "$DST" ]; then backup="$DST.bak.$(date +%s)"; cp -a "$DST" "$backup"; fi
install -m 644 "$tmp" "$DST"
ln -sf "$DST" /etc/nginx/sites-enabled/staysee
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t; then
  echo "Конфигурация не прошла проверку, возвращаю прежнюю."
  if [ -n "$backup" ]; then cp -a "$backup" "$DST"; else rm -f /etc/nginx/sites-enabled/staysee; fi
  exit 1
fi
systemctl reload nginx 2>/dev/null || systemctl restart nginx
echo "nginx применён."
HELPER
chmod 755 /usr/local/bin/staysee-apply-nginx

# 4. Helper: issue the certificate (run by a human after DNS points to this server).
cat > /usr/local/bin/staysee-issue-cert <<'HELPER'
#!/usr/bin/env bash
set -euo pipefail
EMAIL="${1:-}"
[ -n "$EMAIL" ] || { echo "Использование: staysee-issue-cert адрес@почты"; exit 1; }
certbot certonly --webroot -w /var/www/certbot -d staysee.ru -d www.staysee.ru \
  --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
echo "Сертификат выпущен. Запустите выкладку ещё раз, чтобы включить HTTPS-конфигурацию."
HELPER
chmod 755 /usr/local/bin/staysee-issue-cert

# 5. The deploy user may run exactly one command as root.
printf 'deploy ALL=(root) NOPASSWD: /usr/local/bin/staysee-apply-nginx\n' > /etc/sudoers.d/staysee-deploy
chmod 440 /etc/sudoers.d/staysee-deploy
visudo -cf /etc/sudoers.d/staysee-deploy >/dev/null

# 6. Firewall: only SSH, HTTP and HTTPS. (The provider's own security group must allow them too.)
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl enable --now nginx >/dev/null 2>&1 || true

echo
echo "=== ГОТОВО. Что записать дальше ==="
echo "Отпечаток ключа этого сервера (секрет GitHub RU_HOST_FINGERPRINT):"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print "  " $2}'
echo
echo "Достаёт ли сервер до Supabase (нужен ответ 401 или 200):"
curl -sS -o /dev/null -w '  Supabase: HTTP %{http_code} за %{time_total} с\n' --max-time 15 \
  https://jnxrildlwvtxhtiwucbt.supabase.co/auth/v1/health || echo "  Supabase: НЕ ДОСТАЁТСЯ"
