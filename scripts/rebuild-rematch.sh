#!/bin/sh
# Re-match with the 96%-complete C002 cache. No downloads.
set -x
node scripts/rebuild-enrich.mjs
node scripts/rebuild-auto-batch.mjs --batch 60
node scripts/rebuild-enrich.mjs
node scripts/render-missing-details.mjs
node scripts/rebuild-qa-check.mjs
echo "=== REMATCH DONE ==="
