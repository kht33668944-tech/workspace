# 단체문자 v2 — 휴대폰 무료 발송 (SMS Gate 클라우드 릴레이)

기존 SOLAPI(v1, 건당 유료)에 더해, **내 안드로이드 휴대폰으로 직접 발송**하는 v2 엔진을 추가했다.
폰의 문자 무제한 요금제를 쓰므로 **발송비 0원**, 통신사 입장에선 사람이 직접 친 문자라 **`[Web발신]` 태그가 안 붙는다.**

발주서 → 단체문자 모달 상단에서 **휴대폰 / SOLAPI** 를 골라 발송한다. (기본값: 휴대폰)

## 코드 변경 (완료됨)

| 파일 | 변경 |
|------|------|
| `lib/sms-gateway.ts` | 신규 — SMS Gate 클라우드 릴레이 클라이언트 (`sendGatewayMessage`, `toE164`) |
| `app/api/sms/send/route.ts` | `provider: "solapi" \| "phone"` 분기 추가. phone은 건당 큐잉, solapi는 기존 배치 |
| `components/workspace/orders/bulk-sms-modal.tsx` | 발송방식 토글 UI + 비용표시(무료/유료) 분기 |
| `types/database.ts` | `SmsLog`에 `provider` 컬럼 추가 |

## ⚠️ 수동 설정 (이것만 하면 작동함)

### 1. Supabase — sms_logs에 provider 컬럼 추가

Supabase SQL Editor에서 실행:

```sql
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS provider text;
```

(이걸 안 하면 v2 발송은 되지만 발송 이력이 sms_logs에 저장되지 않음)

### 2. 휴대폰에 SMS Gate 앱 설치 + 클라우드 모드 켜기

⚠️ **반드시 공식 capcom6 앱을 써야 함.** Play 스토어 검색 시 같은 이름("SMS Gateway")의
클론 앱(예: MessageCore 제작, 파란 SMS 아이콘, v0.9.x, "Register Device" 토큰 마법사)이 뜨는데
**이건 api.sms-gate.app에 연결 안 되고 username/password도 안 줌.** 절대 사용 금지.

1. 공식 앱 설치: https://github.com/capcom6/android-sms-gateway/releases/latest →
   Assets에서 **`app-release.apk`** 다운로드 후 설치 (버전이 1.65.x 이상이어야 진짜 공식)
   - 진짜 공식 앱 신호: 홈에 **Local server / Cloud server** 섹션 + 하단 **OFFLINE** 버튼.
     "Register Device" / "Set as Default SMS App" 버튼은 **없음**.
2. 앱에서 **Cloud server** 토글 ON → 하단 **OFFLINE** 버튼 눌러 **ONLINE** 전환
3. 첫 연결 시 **username / password 자동 생성** → Cloud server 칸에 표시됨 → `.env.local`에 입력
4. **SMS 발송 권한 허용 (사이드로드 앱은 막혀 있음 — 추가 절차 필수):**
   - 설치 직후엔 폰 설정에서 SMS 권한의 "허용"이 **회색(비활성)** 으로 막혀 있음
     (Play 스토어 외부 설치 앱의 민감권한 차단 = 안드로이드 "제한된 설정")
   - 설정 → 앱 → SMSGate → **우측 상단 ⋮ → "제한된 설정 허용"** → 지문/PIN 인증
   - 그다음 권한 → **SMS / 전화 → "허용"** 선택. (권한 바꾼 뒤 앱 **강제 종료 후 재실행** →
     ONLINE 재연결. 화면 하단 "Not all permissions granted" 토스트가 안 뜨면 정상)
5. (권장) 앱 **Messages** 설정에서 **발송 속도 제한**(분당/시간당 건수, 메시지 간 랜덤 지연) 설정 → 번호 차단 방지
6. (권장) 배터리 최적화 예외("제한 없음") + **Start on boot** ON (재부팅·백그라운드에서 안 꺼지게)

> 발송이 `Failed` + `does not have android.permission.SEND_SMS` 면 → 위 4번(제한된 설정 허용)이 안 된 것.
> `Pending`에서 안 넘어가면 → 폰이 OFFLINE이거나 인터넷 끊김.

### 3. .env.local 환경변수 추가

```
SMS_GATEWAY_USERNAME=앱에서_생성된_username
SMS_GATEWAY_PASSWORD=앱에서_생성된_password
# (선택) 자체 서버/프라이빗 서버 사용 시에만. 기본값은 공용 클라우드.
# SMS_GATEWAY_BASE_URL=https://api.sms-gate.app/3rdparty/v1
```

추가 후 `npm run dev` 재시작.

## 동작 원리 요약

```
웹앱(발송 클릭, provider=phone)
   → /api/sms/send 가 주문별로 sendGatewayMessage() 호출
   → SMS Gate 클라우드(api.sms-gate.app)에 발송 명령 큐잉 (즉시 messageId 반환)
   → 내 폰이 FCM으로 명령 수신 → 유심으로 실제 SMS 발송 (폰 속도제한 적용)
```

- v2는 폰이 **비동기**로 발송하므로, 웹앱의 "성공"은 **"폰에 발송 요청됨(Pending)"** 의미.
  실제 전달 결과는 SMS Gate 앱/대시보드에서 확인 가능. (추후 webhook으로 delivered 상태 동기화 가능)
- 국내번호 `010...` 는 자동으로 `+8210...` (E.164)로 변환되어 발송됨.

## 주의사항

- **하루 500건 이하 권장.** 휴대폰은 통신사가 일일 발송량/속도를 제한하며, 과다 발송 시 번호가 일시 정지될 수 있음. 대량은 SOLAPI(v1) 사용.
- **광고성 문자**는 `[광고]` 표기 + 무료수신거부 안내가 법(정보통신망법)상 의무. `[Web발신]`이 안 붙는 것과 무관하게 지켜야 함.
- 폰이 **켜져 있고 인터넷 연결**돼 있어야 v2 발송 가능. 꺼져 있으면 SOLAPI(v1)로 전환해 발송.
- iPhone은 불가(안드로이드 전용).

## 테스트 (폰 준비 후)

1. 위 1~3 수동 설정 완료
2. 발주서에서 본인 번호가 들어간 주문 1건 선택 → 자동화 → 단체문자
3. 모달 상단 **휴대폰** 선택 확인 (비용 "무료" 표시)
4. 템플릿 작성 → 발송하기 → 진행률 "발송 요청됨" 확인
5. 본인 폰으로 실제 문자 수신 확인 ([Web발신] 태그 없는지 확인)
6. Supabase `sms_logs`에 `provider='phone'` 행 생성 확인
