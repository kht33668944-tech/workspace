// 쿠팡 WING 배송관리 취소 접수 루프
// mcp__playwright__browser_evaluate 로 페이지에 등록한 뒤 window.__run2(N) 으로 배치 호출한다.
//
// 사용법:
//   1) 이 파일 전체를 evaluate 로 실행해 함수 등록
//   2) window.__setup({ match: r => ..., reason: '배송 지연' })  // 대상 판별 함수 지정
//   3) await window.__run2(6) 을 PAGE_END 가 나올 때까지 반복
//   4) PAGE_END 면 다음 페이지로 이동 후 window.__i = 0
//
// 반환: {i, ok, already, other, done}
//   ok      = 이번 배치에서 실제로 접수한 건수
//   already = 이미 접수돼 있어 건너뛴 건수
//   other   = 그 외 이벤트(SKIP_NOT_TARGET / NO_BTN / NO_DLG / 주문번호 불일치 / PAGE_END)

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 상태 ──────────────────────────────────────────────
  window.__i = 0; // 현재 페이지에서 처리 중인 행 인덱스
  window.__fail = [];
  window.__done = new Set(JSON.parse(localStorage.getItem('__doneBak') || '[]'));
  window.__save = () => localStorage.setItem('__doneBak', JSON.stringify([...window.__done]));

  // 기본 대상: 전부. 실제로는 __setup 으로 좁힌다.
  window.__match = () => true;
  window.__reason = '배송 지연';

  // match: (row) => boolean.  row.cells[1]=주문번호, row.cells[6]=상품명
  //   상품명 기준  → r => (r.cells[6]?.innerText||'').includes('까르보나라')
  //   주문번호 기준 → r => targets.has((r.cells[1].innerText||'').replace(/\s+/g,''))
  window.__setup = ({ match, reason }) => {
    if (match) window.__match = match;
    if (reason) window.__reason = reason;
    window.__i = 0;
    return { reason: window.__reason, done: window.__done.size };
  };

  // ── 유틸 ──────────────────────────────────────────────
  const vis = (e) => e.offsetParent !== null;

  const findDlg = () =>
    [...document.querySelectorAll('div')].find(
      (d) => d.innerText && d.innerText.startsWith('취소 접수') && d.querySelector('select')
    );

  // 쌓인 경고 팝업("1건씩만 진행할 수 있습니다" 등)을 전부 닫는다
  window.__closeAlerts = async () => {
    let n = 0;
    for (let i = 0; i < 30; i++) {
      const b = [...document.querySelectorAll('button.alert-action-button')].find(vis);
      if (!b) break;
      b.click();
      n++;
      await sleep(250);
    }
    return n;
  };

  // React 컨트롤드 입력에 값을 넣으려면 native setter + 이벤트가 필요하다
  const setInput = (el, v) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  window.__gotoPage = async (p) => {
    await window.__closeAlerts();
    const a = [...document.querySelectorAll('a')].find(
      (x) => x.textContent.trim() === String(p) && vis(x)
    );
    if (!a) return 'NO_PAGE';
    a.click();
    await sleep(3500);
    window.__i = 0;
    const rows = [...document.querySelectorAll('table')[0].rows].slice(1);
    return { rows: rows.length, i: 0 };
  };

  window.__setPageSize50 = async () => {
    const s = [...document.querySelectorAll('select')].find((x) =>
      [...x.options].some((o) => o.text === '50개씩 보기')
    );
    if (s && s.value !== '50') {
      setInput(s, '50');
      await sleep(3500);
    }
    return [...document.querySelectorAll('table')[0].rows].length - 1;
  };

  // ── 메인 루프 ─────────────────────────────────────────
  window.__run2 = async (N) => {
    const out = [];

    for (let n = 0; n < N; n++) {
      await window.__closeAlerts();

      // 이전 모달이 열려 있으면 닫는다
      const d0 = findDlg();
      if (d0) {
        [...d0.querySelectorAll('button')].find((b) => b.textContent.trim() === '닫기').click();
        await sleep(800);
      }

      const rows = [...document.querySelectorAll('table')[0].rows].slice(1);
      if (window.__i >= rows.length) {
        out.push('PAGE_END');
        break;
      }

      const r = rows[window.__i];
      const ord = (r.cells[1].innerText || '').replace(/\s+/g, '');

      // 대상이 아니면 건너뛴다
      if (!window.__match(r)) {
        out.push(ord + ':SKIP_NOT_TARGET');
        window.__i++;
        continue;
      }

      // 행별 취소접수 버튼. 체크박스 방식은 선택 상태가 페이지를 넘어 남아
      // "1건씩만 진행할 수 있습니다" 에러를 유발하므로 쓰지 않는다.
      const btn = r.cells[14].querySelector('button');
      if (!btn) {
        out.push(ord + ':NO_BTN');
        window.__i++;
        continue;
      }
      btn.click();
      await sleep(1500);

      const dlg = findDlg();
      if (!dlg) {
        out.push(ord + ':NO_DLG');
        window.__fail.push(ord);
        break;
      }

      // 엉뚱한 주문을 취소하지 않도록 모달 주문번호를 반드시 대조한다
      const mOrd = (dlg.innerText.match(/주문번호:\s*(\d+)/) || [])[1] || '';
      if (mOrd !== ord) {
        out.push(ord + '!=' + mOrd);
        window.__fail.push(ord);
        break;
      }

      const inp = dlg.querySelector('input[type=number]');

      // 수량 입력란이 잠겨 있으면 이미 접수된 건 → 중복 접수 방지
      if (inp.disabled) {
        out.push(ord + ':ALREADY');
        [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '닫기').click();
        await sleep(700);
        window.__done.add(ord);
        window.__save();
        window.__i++;
        continue;
      }

      // 취소접수수량 = 주문 수량 전량
      const qty = (dlg.querySelector('table').rows[2].cells[3].innerText || '').trim();
      setInput(inp, qty);

      // 판매자사유(첫 라디오) + 사유 select
      const radios = [...dlg.querySelectorAll('input[type=radio]')];
      if (!radios[0].checked) radios[0].click();
      const s = dlg.querySelector('select');
      const opt = [...s.options].find((o) => o.text === window.__reason);
      if (!opt) {
        out.push(ord + ':NO_REASON');
        window.__fail.push(ord);
        break;
      }
      setInput(s, opt.value);
      await sleep(350);

      const sub = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === '접수');
      if (sub.disabled) {
        out.push(ord + ':DISABLED');
        window.__fail.push(ord);
        break;
      }
      sub.click();
      await sleep(1700);

      window.__done.add(ord);
      window.__save();
      window.__i++;
      out.push(ord + ':OK');
    }

    return {
      i: window.__i,
      ok: out.filter((x) => x.endsWith(':OK')).length,
      already: out.filter((x) => x.endsWith(':ALREADY')).length,
      other: out.filter((x) => !/:(OK|ALREADY)$/.test(x)),
      done: window.__done.size,
    };
  };

  return 'cancel-loop registered';
})();
