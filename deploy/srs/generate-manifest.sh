#!/usr/bin/env bash
# generate-manifest.sh — (dev-time only) extract every SRS requirement ID from
# the SRS_DOCUMENTS tree and classify its test METHOD by module prefix, writing
# a static deploy/srs/manifest.tsv that run.sh reconciles against on the VPS
# (the VPS has no SRS docs). Re-run locally whenever the SRS changes.
#   Usage: SRS_ROOT=/path/to/SRS_DOCUMENTS bash deploy/srs/generate-manifest.sh
set -uo pipefail
SRS_ROOT="${SRS_ROOT:-../../../SRS_DOCUMENTS}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/manifest.tsv"
[ -d "$SRS_ROOT" ] || { echo "SRS_ROOT not found: $SRS_ROOT"; exit 1; }

method_for(){ # prefix → METHOD
  case "$1" in
    FR-UI|FR-NAV|FR-DISP|FR-BRND|FR-NAME|FR-OFF|FR-STATE|FR-IMG) echo DEVICE ;;
    FR-SECX|FR-PRIV) echo SECURITY ;;
    FR-TIME|FR-CONC|FR-LIM|FR-MEMX) echo PERF ;;
    *) echo API ;;
  esac
}

printf 'requirement_id\tmodule\tmethod\n' > "$OUT"
grep -rhoE '\b(FR|NFR)-[A-Z]+-[0-9]+' "$SRS_ROOT" --include=*.md 2>/dev/null | sort -u | while read -r id; do
  pref="$(echo "$id" | sed -E 's/-[0-9]+$//')"
  printf '%s\t%s\t%s\n' "$id" "$pref" "$(method_for "$pref")" >> "$OUT"
done
echo "wrote $OUT ($(( $(wc -l < "$OUT") - 1 )) requirements)"
