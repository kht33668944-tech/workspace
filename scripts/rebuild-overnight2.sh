#!/bin/sh
# Round 2: finish C002 (resumable, waits for daily quota), then re-match everything.
set -x
node scripts/mfds-bulk-download.mjs C002
node scripts/mfds-bulk-download.mjs C003
node scripts/rebuild-enrich.mjs
node scripts/rebuild-auto-batch.mjs --batch 60
node scripts/rebuild-enrich.mjs
node scripts/regenerate-detail-html.mjs --apply
node scripts/render-missing-details.mjs
node scripts/rebuild-qa-check.mjs
echo "=== ROUND2 DONE ==="
