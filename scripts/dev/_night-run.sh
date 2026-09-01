#!/bin/bash
# 00:15 자동 최저가 갱신 종료를 기다렸다가 마켓 가격 전체 동기화 실행
cd "C:/Users/sksso/Desktop/개발/workspace-dev"
LOG=logs/night-sync.log
echo "[$(date '+%F %T')] 대기 시작 (auto-price 종료 감시)" >> $LOG
START=$(date +%s)
while true; do
  F="scripts/logs/auto-price-$(date +%F).log"
  if [ -f "$F" ] && grep -q "=== 종료" "$F"; then
    LAST=$(stat -c %Y "$F")
    if [ $LAST -gt $START ] && [ $(( $(date +%s) - LAST )) -gt 60 ]; then break; fi
  fi
  if [ $(( $(date +%s) - START )) -gt 10800 ]; then echo "[$(date '+%F %T')] 3시간 대기 초과 — 갱신 종료 미감지, 동기화 강행" >> $LOG; break; fi
  sleep 60
done
echo "[$(date '+%F %T')] 자동 갱신 종료 감지 → 마켓 동기화 시작" >> $LOG
grep "=== 종료\|API 반영" "scripts/logs/auto-price-$(date +%F).log" | tail -3 >> $LOG
npx tsx scripts/dev/sync-market-prices.mts --platform all 2>&1 | grep -v "^\[naver-api\]\|^\[coupang-api\]" >> $LOG
echo "[$(date '+%F %T')] 완료" >> $LOG
