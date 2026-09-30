#!/usr/bin/env bash
cd "$(dirname "$0")"

# Change these before you let anyone else in
export MEMBER_PASSCODE="${MEMBER_PASSCODE:-guild}"
export OFFICER_PASSCODE="${OFFICER_PASSCODE:-officer}"
export PORT="${PORT:-3000}"
# Look for new code on GitHub every 5 minutes (only does anything if this folder came from GitHub)
export AUTO_UPDATE_MINUTES="${AUTO_UPDATE_MINUTES:-5}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org/en/download and run this again."
  exit 1
fi
open_browser() { sleep 2; (open "$1" || xdg-open "$1") >/dev/null 2>&1; }

echo "Guild Hall is starting on http://localhost:$PORT  (Ctrl+C to stop)"
open_browser "http://localhost:$PORT" &
while true; do
  node server.js
  code=$?
  if [ "$code" -eq 75 ]; then
    echo "New version found on GitHub. Updating..."
    git pull --ff-only
    continue
  fi
  exit "$code"
done
