#!/bin/sh
# GuildHub RC4 - READ-ONLY pre-flight check of the Security Ledger state. Changes nothing, prints no secrets.
# Run as root on the Docker host, with the GuildHub container of this environment STOPPED.
#
#   staging: LEDGER=/opt/persistent_volume/guildhub-test/GUILDHUB_LEDGER DATA=/opt/persistent_volume/guildhub-test/data sh guildhub-preflight.sh
#   live:    LEDGER=/opt/persistent_volume/guildhub/GUILDHUB_LEDGER      DATA=/opt/persistent_volume/guildhub/data      sh guildhub-preflight.sh
#
# Last line is the verdict:
#   FIRST-INIT-ALLOWED   no Ledger and no binding yet -> exactly one start with GUILDHUB_LEDGER_BOOTSTRAP=acknowledge-current-state
#   ESTABLISHED          Ledger and binding exist and match in shape -> start WITHOUT the bootstrap variable
#   INTERRUPTED-INIT     an initialization was interrupted -> start RC4 once WITHOUT bootstrap (it finishes it); delete nothing
#   STOP                 anything else -> do not start RC4, do not delete or reset anything, send the output for review
LEDGER=${LEDGER:?set LEDGER to the host folder mounted at /app/security-ledger}
DATA=${DATA:?set DATA to the host folder mounted at /data}
problems=0
say() { printf '%s\n' "$*"; }
bad() { say "  !! $*"; problems=$((problems+1)); }

say "== Ledger folder: $LEDGER"
if [ ! -d "$LEDGER" ]; then bad "does not exist (Docker would create it as 0755 and RC4 would refuse to start)"; else
  mode=$(stat -c '%a' "$LEDGER"); owner=$(stat -c '%U:%G' "$LEDGER")
  say "  mode $mode, owner $owner"
  [ "$mode" = 700 ] || bad "mode must be 700 (fix: chmod 700 '$LEDGER')"
  [ "$(stat -c '%u' "$LEDGER")" = 0 ] || bad "owner must be root, the container runs as root (fix: chown root:root '$LEDGER')"
  [ -L "$LEDGER" ] && bad "is a symbolic link"
fi
lfiles=$( [ -d "$LEDGER" ] && find "$LEDGER" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')
say "  contents: ${lfiles:-(empty)}"

say "== Data folder: $DATA"
[ -d "$DATA" ] || bad "does not exist"
[ -f "$DATA/db.json" ] && say "  db.json present ($(stat -c '%s' "$DATA/db.json") bytes, $(stat -c '%y' "$DATA/db.json" | cut -c1-16))" || say "  db.json NOT present (a brand-new installation)"
[ -f "$DATA/secret.txt" ] && say "  secret.txt present (content not read)"
for f in security-ledger-binding.json security-ledger-binding.json.enrollment session-revocations.json session-revocations.pre-ledger.json; do
  [ -e "$DATA/$f" ] && say "  $f present ($(stat -c '%s' "$DATA/$f") bytes)"
done
[ -d "$DATA/security-ledger" ] && bad "$DATA/security-ledger exists (an old fallback Ledger folder) - review before any start"
enr=""; [ -f "$DATA/security-ledger-binding.json.enrollment" ] && enr=$(grep -o '"status":"[a-z]*"' "$DATA/security-ledger-binding.json.enrollment" | cut -d'"' -f4)
[ -n "$enr" ] && say "  enrollment status: $enr"

has() { [ -e "$LEDGER/$1" ]; }
others=$(printf '%s' "$lfiles" | tr ' ' '\n' | grep -vE '^(writer\.lock|.*\.tmp)?$' | tr '\n' ' ')
binding=no; [ -f "$DATA/security-ledger-binding.json" ] && binding=yes
say "== Decision"
if [ "$problems" -gt 0 ]; then verdict=STOP
elif has initialization.json; then verdict=INTERRUPTED-INIT
elif [ -z "$others" ] && [ "$binding" = no ] && [ -z "$enr" ]; then verdict=FIRST-INIT-ALLOWED
elif has key.json && has head.json && has events.jsonl && [ "$binding" = yes ] && [ "$enr" = established ]; then verdict=ESTABLISHED
else
  verdict=STOP
  [ -z "$others" ] && [ "$binding" = yes ] && say "  /data is already bound to a Ledger but the Ledger folder is empty: wrong folder mounted? Find the real one (guildhub-ledger-diagnose.sh, section 5). Never bootstrap here."
  [ -n "$others" ] && [ "$binding" = no ] && say "  Ledger files exist but /data has no binding: wrong /data folder, or a restored /data backup older than the Ledger."
fi
say "VERDICT: $verdict"
