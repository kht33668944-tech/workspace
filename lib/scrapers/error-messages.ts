function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function isReadableKoreanMessage(message: string): boolean {
  return /[가-힣]/.test(message) && !/(locator|Timeout|Call log|waiting for|Selector|Target page|net::ERR)/i.test(message);
}

export function formatAutomationError(error: unknown): string {
  const raw = stripAnsi(error instanceof Error ? error.message : String(error)).trim();
  if (!raw) return "자동화 중 알 수 없는 오류가 발생했습니다.";
  if (isReadableKoreanMessage(raw)) return raw;

  if (/coreInsOrderBtn|has-text\("구매하기"\)|has-text\('구매하기'\)|구매하기/.test(raw)) {
    return "구매하기 버튼을 찾지 못했습니다. 상품이 품절/판매종료되었거나, 구매처 화면이 바뀌었거나, 로그인/인증/옵션 선택 화면에서 막혔을 수 있습니다.";
  }

  if (/결제하기|payBtn|payment|Payment/i.test(raw)) {
    return "결제 버튼을 찾지 못했습니다. 결제수단 선택, 본인인증, 품절 안내, 구매처 화면 변경 여부를 확인해야 합니다.";
  }

  if (/login|sign[_-]?in|아이디|비밀번호/i.test(raw)) {
    return "로그인 단계에서 멈췄습니다. 구매처 계정 정보가 맞는지, 추가 인증이나 캡차가 떴는지 확인해야 합니다.";
  }

  if (/captcha|캡차|로봇|bot|Cloudflare/i.test(raw)) {
    return "구매처에서 자동화를 감지했거나 캡차 인증이 필요합니다. 잠시 후 다시 시도하거나 브라우저에서 직접 인증이 필요한지 확인해야 합니다.";
  }

  if (/주소|배송지|address|zip|postcode/i.test(raw)) {
    return "배송지 입력 단계에서 멈췄습니다. 주소 검색 결과가 없거나, 구매처 배송지 화면이 바뀌었을 수 있습니다.";
  }

  if (/Timeout/i.test(raw)) {
    return "정해진 시간 안에 다음 화면이 열리지 않았습니다. 구매처 페이지가 느리거나, 예상과 다른 안내/팝업/인증 화면이 떠 있을 수 있습니다.";
  }

  if (/Target page|browser has been closed|context.*closed|Page closed/i.test(raw)) {
    return "자동화 브라우저가 중간에 닫혀 작업을 계속할 수 없었습니다. 브라우저가 수동으로 닫혔거나 구매처 페이지가 강제로 종료됐을 수 있습니다.";
  }

  if (/net::ERR|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED/i.test(raw)) {
    return "구매처 페이지 접속에 실패했습니다. 인터넷 연결, 구매처 접속 상태, 일시적인 네트워크 오류를 확인해야 합니다.";
  }

  return "자동화 중 예상하지 못한 오류가 발생했습니다. 구매처 화면이 평소와 다르거나 팝업/인증/품절 안내가 떠 있을 수 있습니다.";
}
