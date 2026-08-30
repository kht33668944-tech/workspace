import XLSX from "xlsx-js-style";
const wb = XLSX.readFile(process.argv[2]);
console.log("시트:", wb.SheetNames.join(", "));
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
console.log("행", rows.length);
console.log("컬럼:", Object.keys(rows[0]??{}).join(" | "));
console.log("\n예시 3행:");
rows.slice(0,3).forEach(r=>console.log(JSON.stringify(r).slice(0,500)));
