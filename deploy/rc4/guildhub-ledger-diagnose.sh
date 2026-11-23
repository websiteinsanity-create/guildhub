#!/bin/sh
# GuildHub RC4 – READ-ONLY diagnostics. Changes nothing, prints no keys, tokens or records.
# Run as root on the Docker host. Safe whether the old version or RC4 is running, or nothing is.
# Adjust the three paths/names below only if your stack differs.
C=${C:-guild-hall}                                          # container name (shipped compose: guild-hall)
LEDGER=${LEDGER:-/opt/persistent_volume/guildhub/GUILDHUB_LEDGER} # host side of /app/security-ledger
DATA=${DATA:-/opt/persistent_volume/guildhub/data}           # host side of /data

echo "== 1. containers and images"
docker ps -a --filter "name=$C" --format '{{.Names}}  {{.Image}}  {{.Status}}'
docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.CreatedAt}}' | grep -i guild

echo "== 2. version actually running"
docker exec "$C" node -e "console.log(require('/app/package.json').version)" 2>/dev/null || echo "(container not running)"

echo "== 3. effective mounts"
docker inspect -f '{{range .Mounts}}{{.Type}}  {{.Source}} -> {{.Destination}}  rw={{.RW}}{{println}}{{end}}' "$C" 2>/dev/null

echo "== 4. Ledger-related environment only (values shown between | | to reveal stray spaces)"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$C" 2>/dev/null | grep -E '^(NODE_ENV|GUILDHUB_LEDGER_[A-Z_]*)=' | sed -E 's/^([A-Z_]+)=(.*)$/\1=|\2|/'

echo "== 5. every ledger-like directory under /opt/persistent_volume (finds look-alikes)"
find /opt/persistent_volume -maxdepth 5 -iname '*ledger*' -printf '%M %u:%g %6s %TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null

echo "== 6. mounted Ledger directory: owner, mode, file names and sizes"
stat -c '%A (%a) %U:%G  %n' "$LEDGER" 2>&1
find "$LEDGER" -mindepth 1 -maxdepth 1 -printf '%M %u:%g %8s %TY-%Tm-%Td %TH:%TM  %f\n' 2>&1 | sort -k6
[ -f "$LEDGER/writer.lock" ] && printf 'writer.lock format: %s\n' "$(grep -q '"v":2' "$LEDGER/writer.lock" && echo 'RC3/RC4 kernel lock' || ( [ -s "$LEDGER/writer.lock" ] && echo 'legacy (RC2) presence lock' || echo 'empty' ))"

echo "== 7. trust and security files in DATA_DIR (names, sizes, dates only)"
find "$DATA" -maxdepth 1 \( -name 'security-ledger*' -o -name 'session-revocations*' -o -name 'support-grants.json' -o -name 'db.json' -o -name 'secret.txt' \) -printf '%M %u:%g %10s %TY-%Tm-%Td %TH:%TM  %f\n' 2>&1 | sort -k6
[ -f "$DATA/security-ledger-binding.json.enrollment" ] && echo "enrollment status: $(grep -o '"status":"[a-z]*"' "$DATA/security-ledger-binding.json.enrollment")"
[ -d "$DATA/security-ledger" ] && { echo "!! DATA_DIR contains an older fallback ledger folder:"; find "$DATA/security-ledger" -mindepth 1 -maxdepth 1 -printf '%M %u:%g %8s %TY-%Tm-%Td %TH:%TM  %f\n'; }

echo "== 8. what the failed RC4 container said (only Ledger/FATAL lines)"
for n in $(docker ps -a --format '{{.Names}}' | grep -i guild); do echo "-- $n"; docker logs --tail 200 "$n" 2>&1 | grep -E 'FATAL|ledger|Ledger' | sort | uniq -c | tail -10; done
