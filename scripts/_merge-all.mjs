// 다운로드 폴더의 모든 등록 결과를 모아 통합결과를 만든다 (파일명에 공백이 있어 쉘 확장을 피한다).
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
const dl = path.join(os.homedir(), "Downloads");
const files = fs.readdirSync(dl)
  .filter((f) => f.endsWith(".xlsx") && /26082[34].*쇼핑몰상품_단일_엑셀일괄등록_결과|쿠팡\(.*상품등록_작업결과_2026082[34]|플레이오토_쿠팡_260823/.test(f))
  .map((f) => path.join(dl, f));
console.log(`결과 파일 ${files.length}개`);
files.forEach((f) => console.log("  " + path.basename(f)));
execFileSync(process.execPath, ["scripts/merge-results.mjs", ...files], { stdio: "inherit" });
