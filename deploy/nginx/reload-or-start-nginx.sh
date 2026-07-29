#!/usr/bin/env bash
# Reload nginx if active; otherwise start. Fail if still inactive.
# Shared by apply-on-vps.sh (source of truth for CI/VPS nginx apply).
set -euo pipefail

sudo nginx -t

if sudo systemctl is-active --quiet nginx; then
  sudo systemctl reload nginx
  echo "nginx reloaded"
else
  sudo systemctl start nginx
  echo "nginx started (was inactive)"
fi

if ! sudo systemctl is-active --quiet nginx; then
  sudo systemctl status nginx --no-pager -l || true
  sudo journalctl -u nginx -n 100 --no-pager || true
  exit 1
fi
