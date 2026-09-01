#!/bin/bash
# 08:20 에 OnliveAutoPrice 재활성화 (08:15 회차만 건너뜀)
while [ $(date +%H%M) -lt 0820 ]; do sleep 60; done
powershell -Command "Enable-ScheduledTask -TaskName OnliveAutoPrice" > /dev/null 2>&1
echo "[$(date '+%F %T')] OnliveAutoPrice 재활성화" >> logs/night-sync.log
