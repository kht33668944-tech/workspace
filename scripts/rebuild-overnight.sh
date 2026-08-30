#!/bin/sh
# MFDS bulk download + rebuild chain. Run: sh scripts/rebuild-overnight.sh
set -x
node scripts/mfds-bulk-download.mjs C002
node scripts/mfds-bulk-download.mjs C003
node scripts/rebuild-enrich.mjs
node scripts/rebuild-auto-batch.mjs --batch 60
node scripts/rebuild-enrich.mjs
node scripts/regenerate-detail-html.mjs --apply
node scripts/render-missing-details.mjs --all
node scripts/rebuild-qa-check.mjs
echo "=== OVERNIGHT DONE ==="
