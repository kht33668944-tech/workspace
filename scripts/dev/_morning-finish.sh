#!/bin/bash
cd "C:/Users/sksso/Desktop/개발/workspace-dev"
LOG=logs/night-sync.log
echo "[$(date '+%F %T')] 아침 마무리: 마켓 동기화 시작" >> $LOG
npx tsx scripts/dev/sync-market-prices.mts --platform all 2>&1 | grep -v "^\[naver-api\]\|^\[coupang-api\]" >> $LOG
echo "[$(date '+%F %T')] ESM 엑셀 생성" >> $LOG
npx tsx scripts/dev/export-esm-price-excel.mts >> $LOG 2>&1
echo "[$(date '+%F %T')] 전체 완료" >> $LOG
