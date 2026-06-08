#!/usr/bin/env bash
# Resolve and verify nginx document root for StaySee SPA.
# Sourced by apply-on-vps.sh — do not hardcode paths without running these checks.

set -euo pipefail

STAYSEE_NGINX_CONF="${STAYSEE_NGINX_CONF:-/etc/nginx/sites-available/staysee}"

RESOLVED_WEB_ROOT=""
RESOLVED_WEB_ROOT_SOURCE=""

read_live_nginx_root() {
  if [[ ! -f "$STAYSEE_NGINX_CONF" ]]; then
    return 0
  fi
  awk '
    /server_name/ { in_server=1 }
    in_server && /root \/var\/www\/certbot/ { next }
    in_server && /^[[:space:]]*root[[:space:]]+/ {
      gsub(/;/, "", $2)
      print $2
      exit
    }
  ' "$STAYSEE_NGINX_CONF"
}

verify_web_root() {
  local root="$1"

  if [[ -z "$root" ]]; then
    echo "empty path" >&2
    return 1
  fi
  if [[ ! -d "$root" ]]; then
    echo "directory missing: $root" >&2
    return 1
  fi
  if [[ ! -f "$root/index.html" ]]; then
    echo "index.html missing: $root/index.html" >&2
    return 1
  fi
  if [[ ! -d "$root/assets" ]]; then
    echo "assets/ missing: $root/assets" >&2
    return 1
  fi
  return 0
}

report_web_root_check() {
  local root="$1"
  local label="$2"
  if verify_web_root "$root" 2>/dev/null; then
    echo "[nginx-preflight] OK  $label → $root" >&2
    return 0
  fi
  local err
  err=$(verify_web_root "$root" 2>&1 || true)
  echo "[nginx-preflight] FAIL $label → $root ($err)" >&2
  return 1
}

resolve_staysee_web_root() {
  local repo_dir="${STAYSEE_REPO_DIR:-$HOME/Staysee-app}"
  local current="" candidate="" chosen=""

  echo "[nginx-preflight] resolving web root..." >&2

  if [[ -n "${STAYSEE_WEB_ROOT:-}" ]]; then
    report_web_root_check "$STAYSEE_WEB_ROOT" "STAYSEE_WEB_ROOT" || exit 1
    RESOLVED_WEB_ROOT="$STAYSEE_WEB_ROOT"
    RESOLVED_WEB_ROOT_SOURCE="STAYSEE_WEB_ROOT"
    return 0
  fi

  current=$(read_live_nginx_root || true)
  if [[ -n "$current" ]]; then
    echo "[nginx-preflight] live nginx root: $current" >&2
    if report_web_root_check "$current" "current nginx config"; then
      RESOLVED_WEB_ROOT="$current"
      RESOLVED_WEB_ROOT_SOURCE="live-nginx-config"
      return 0
    fi
    echo "[nginx-preflight] live root invalid — trying candidates" >&2
  else
    echo "[nginx-preflight] no live nginx root (fresh install?)" >&2
  fi

  local candidates=(
    "/var/www/Staysee-app/dist"
    "$repo_dir/dist"
  )

  for candidate in "${candidates[@]}"; do
    if report_web_root_check "$candidate" "candidate"; then
      chosen="$candidate"
      break
    fi
  done

  if [[ -z "$chosen" ]]; then
    echo "[nginx-preflight] ERROR: no valid web root found" >&2
    echo "[nginx-preflight] Set STAYSEE_WEB_ROOT or fix dist deploy before applying nginx" >&2
    exit 1
  fi

  RESOLVED_WEB_ROOT="$chosen"
  RESOLVED_WEB_ROOT_SOURCE="candidate-list"
}
