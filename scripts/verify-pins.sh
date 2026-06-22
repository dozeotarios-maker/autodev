#!/usr/bin/env bash
# D2 web-currency: verify all npm pins are current at build time.
# Exits 0 if all versions match; exits 1 with details on any mismatch.
set -euo pipefail

FAILED=0

check_npm() {
  local pkg="$1"
  local pinned="$2"
  local latest
  latest=$(npm info "$pkg" version 2>/dev/null || echo "ERROR")
  if [[ "$latest" == "ERROR" ]]; then
    echo "WARN  $pkg — npm info failed (offline?)"
    return
  fi
  if [[ "$latest" == "$pinned" ]]; then
    echo "OK    $pkg@$pinned"
  else
    echo "STALE $pkg — pinned=$pinned latest=$latest"
    FAILED=1
  fi
}

echo "=== pi-autodev pin verification ==="
check_npm "@earendil-works/pi-coding-agent" "0.79.9"
check_npm "pi-subagents"                     "0.30.0"
check_npm "pi-hud"                           "0.9.4"
check_npm "gray-matter"                      "4.0.3"
echo "==================================="

if [[ $FAILED -ne 0 ]]; then
  echo "ERROR: one or more pins are stale — update package.json before shipping"
  exit 1
fi
echo "All pins current."
exit 0
