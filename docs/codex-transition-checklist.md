# Codex 전환 체크리스트

이 문서는 Claude Code에서 Codex 중심 작업으로 넘어오면서 확인한 기본 세팅입니다.

## 완료한 기준

- `AGENTS.md`를 Codex 기준 운영 문서로 사용한다.
- `CLAUDE.md`는 과거 작업 참고용으로 남긴다.
- `.claude/` 설정은 사용자가 요청하지 않으면 수정하거나 삭제하지 않는다.
- `.codex/`, `.env.local`, `.mcp.json` 같은 비밀 설정은 커밋하지 않는다.
- 기본 검증 명령은 `npm run verify`로 통일한다.
- 비개발자 사용자를 기준으로 답변은 짧고 쉽게 한다.

## 작업 전 확인

```bash
git status --short
npm run verify
```

`git status`에서 내가 건드리지 않은 변경이 있으면 보존한다. `.env.local`, `.codex/`, `.mcp.json`은 로컬 비밀 설정이므로 문서나 커밋에 포함하지 않는다.

## 작업 후 확인

```bash
npm run verify
```

화면이나 자동화 동작을 바꾼 경우에는 개발 서버를 켜고 브라우저에서 직접 확인한다.

## 남겨둔 참고

- `docs/superpowers/`에는 이전 설계/계획 문서가 남아 있다.
- 장기적으로 다시 쓸 절차나 결정은 Obsidian LLM Wiki에 한국어로 기록한다.
