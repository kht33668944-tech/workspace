#!/bin/bash
cd "C:/Users/sksso/Desktop/개발/workspace-dev"
LOG=logs/night-sync.log
echo "[$(date '+%F %T')] 재실행: 전체 최저가 갱신(초기화) 시작" >> $LOG
node scripts/auto-price-refresh.mjs --label 야간재실행 --reset 2>&1 | grep "라운드 완료\|가격 적용\|API 반영\|마진 처리\|종료\|치명" >> $LOG
echo "[$(date '+%F %T')] 마켓 동기화 시작" >> $LOG
npx tsx scripts/dev/sync-market-prices.mts --platform all 2>&1 | grep -v "^\[naver-api\]\|^\[coupang-api\]" >> $LOG
echo "[$(date '+%F %T')] ESM 엑셀 생성" >> $LOG
npx tsx scripts/dev/export-esm-price-excel.mts >> $LOG 2>&1
echo "[$(date '+%F %T')] 전체 완료" >> $LOG
