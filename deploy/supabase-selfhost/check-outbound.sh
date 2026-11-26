#!/usr/bin/env bash
# Run this ON the server you are thinking of buying (in its first hour, before paying for a month).
# It asks every outside address the app needs and prints one line each: OK (an answer came, even "401 no key" counts) or NO (nothing came).
# No key, no password, nothing of the app is sent. Run: bash check-outbound.sh
# The result is true only for the network of the machine it runs on: a VPN on that machine changes it.

ok_count=0
no_count=0

# check <what for> <address> [POST]
check() {
  local what="$1" url="$2" method="${3:-GET}"
  local out code time
  if [ "$method" = "POST" ]; then
    out="$(curl -sS -m 12 -o /tmp/outbound-body.$$ -w '%{http_code} %{time_total}' -X POST -H 'Content-Type: application/json' -d '{}' "$url" 2>&1)"
  else
    out="$(curl -sS -m 12 -o /tmp/outbound-body.$$ -w '%{http_code} %{time_total}' "$url" 2>&1)"
  fi
  code="${out%% *}"
  time="${out##* }"
  if [[ "$code" =~ ^[0-9]{3}$ ]] && [ "$code" != "000" ]; then
    note=""
    # 403 / 451 mean: the address answered, but refused us (a region block), worth reading.
    if [ "$code" = "403" ] || [ "$code" = "451" ]; then note="  <-- REFUSED, read: $(head -c 120 /tmp/outbound-body.$$ | tr '\n' ' ')"; fi
    printf 'OK  %-44s %s  (%ss)%s\n' "$what" "$code" "$time" "$note"
    ok_count=$((ok_count + 1))
  else
    printf 'NO  %-44s no answer: %s\n' "$what" "$(echo "$out" | tail -n 1 | cut -c1-90)"
    no_count=$((no_count + 1))
  fi
  rm -f /tmp/outbound-body.$$
}

echo "== needed once, to install (can be avoided by carrying the files in)"
check "Docker Hub (images)"                    "https://registry-1.docker.io/v2/"
check "AWS public registry (Supabase images)"  "https://public.ecr.aws/v2/"
check "GitHub (code, deploy)"                  "https://github.com"
check "npm (function libraries)"               "https://registry.npmjs.org/@supabase/supabase-js/2.107.0"
check "jsr (function libraries)"               "https://jsr.io/@panva/jose/meta.json"

echo "== needed all the time, while the app works"
check "OpenRouter: models list"                "https://openrouter.ai/api/v1/models"
check "OpenRouter: chat (no key: 401 expected)" "https://openrouter.ai/api/v1/chat/completions" POST
check "Telegram: alerts (bot api)"             "https://api.telegram.org/bot0/getMe"
check "Cloud.ru models (no key: 401 expected)" "https://foundation-models.api.cloud.ru/v1/models"

echo
echo "answered: $ok_count, no answer: $no_count"
[ "$no_count" -eq 0 ] || echo "Every NO is a place where the app, or its installation, would break on this machine."
