#!/bin/bash
# night-run 완료 후 ESM 가격수정 엑셀 전체 생성
cd "C:/Users/sksso/Desktop/개발/workspace-dev"
LOG=logs/night-sync.log
while ! grep -q "] 완료" $LOG 2>/dev/null; do sleep 60; done
echo "[$(date '+%F %T')] ESM 가격수정 엑셀 생성 시작" >> $LOG
npx tsx scripts/dev/export-esm-price-excel.mts >> $LOG 2>&1
echo "[$(date '+%F %T')] ESM 엑셀 완료" >> $LOG
