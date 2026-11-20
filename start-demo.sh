#!/usr/bin/env bash
cd "$(dirname "$0")"

# Demo mode: fake guild data in ./demo-data. Your real data in ./data is not touched.
export MEMBER_PASSCODE="${MEMBER_PASSCODE:-guild}"
export OFFICER_PASSCODE="${OFFICER_PASSCODE:-officer}"
export PORT="${PORT:-3000}"
export DATA_DIR="$PWD/demo-data"
export DEMO_MODE=1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org/en/download and run this again."
  exit 1
fi
open_browser() { sleep 2; (open "$1" || xdg-open "$1") >/dev/null 2>&1; }

node seed-demo.js
echo "Demo is starting on http://localhost:$PORT  (Ctrl+C to stop)"
echo "Passcode 'officer' = officer tools, 'guild' = normal member. Delete ./demo-data to reset."
open_browser "http://localhost:$PORT" &
node server.js
