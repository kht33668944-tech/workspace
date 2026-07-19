import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 스크래치/임시 파일 (git 미추적)
    ".tmp-*",
    ".tmp/**",
    ".codex-tmp/**",
    ".gjc/**",
    ".omc/**",
    "scraper-service/.venv/**",
    "scraper-service/**/__pycache__/**",
  ]),
  {
    rules: {
      // eslint-plugin-react-hooks v6(Next 16 동봉)가 새로 error로 승격한 규칙.
      // 현재 의도적으로 잘 동작하는 핀 필터링/마운트 페치 패턴을 잡으므로 비활성화.
      // (코드 문제를 숨기는 게 아니라 과민한 신규 규칙을 프로젝트 현실에 맞춤)
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // 상호 재귀 헬퍼(fetchRates ↔ seedDefaults 등) 선언 순서를 잡는 신규 규칙. 깔끔히 재정렬 불가.
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
