#!/usr/bin/env sh
# Checks your Discord setup step by step (see README, "Testing your bot").
#   ./check-discord.sh                     or:  ./check-discord.sh --channel <id> --dm <user id>
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org"; exit 1; }
exec node check-discord.js "$@"
