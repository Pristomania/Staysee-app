# iOS Safari — server checklist (staysee.ru)

Symptoms: Safari «сервер перестал отвечать»; Chrome on iPhone hangs after login; Android OK.

## 1. Nginx logs (run on VPS during iPhone test)

```bash
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

Look for: 499 (client closed), 502/504 (upstream), SSL errors, slow requests.

## 2. SSL / certificate (on VPS)

```bash
sudo openssl s_client -connect staysee.ru:443 -servername staysee.ru -tls1_2 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
echo | openssl s_client -connect staysee.ru:443 -servername staysee.ru 2>/dev/null | openssl x509 -noout -text | grep -A1 "Issuer"
```

Expect: Let's Encrypt issuer, valid dates, full chain via `fullchain.pem`.

## 3. TLS timing (from any machine)

```bash
curl -o /dev/null -s -w 'connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' https://staysee.ru/
```

If `tls` or `ttfb` > 2s on cold connections, enable `ssl_session_cache` (see `staysee.ru.conf`).

## 4. HTTP/2 A/B test

```bash
# Uses resolve-web-root.sh — same root checks as prod apply
STAYSEE_NGINX_SRC=deploy/nginx/staysee.ru.no-http2.conf bash deploy/nginx/apply-on-vps.sh
```

Test iPhone Safari. Revert with `staysee.ru.conf` + `apply-on-vps.sh` if no change.

## 5. gzip / brotli

Stock config uses **gzip only** (no brotli module). To disable gzip for test:

```nginx
gzip off;
```

## 6. Service worker

StaySee SPA has **no service worker**. No PWA cache to clear. Hard refresh on iOS: Settings → Safari → Clear History (or private tab).

## 7. Bundle size

Main JS (~418 KB uncompressed). After deploy, check:

```bash
ls -lh /var/www/Staysee-app/dist/assets/*.js
curl -sI https://staysee.ru/assets/index-*.js | grep -i content-encoding
```

gzip should show `Content-Encoding: gzip` after nginx reload.

## 8. Cloudflare

Static site is **direct nginx** (no CF in front of staysee.ru). `/supabase/` proxy hits `*.supabase.co` (Cloudflare on Supabase side) — normal.

## 9. Direct URL tests (iPhone Safari)

- https://staysee.ru/
- https://staysee.ru/?v=ios-test
- https://staysee.ru/index.html

## 10. Frontend fixes (repo)

- Removed `processLock` from Supabase client (iOS auth hang).
- Upgraded `@supabase/supabase-js` to 2.107+ (lockless auth default).
- Loading fallback after 8s: «Обновить» / «Выйти».
