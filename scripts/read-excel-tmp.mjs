import XLSX from 'xlsx';
const wb = XLSX.readFile('C:/Users/sksso/Desktop/판매자관리코드 수정1.xlsx');
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('=== Sheet:', name, '| rows:', rows.length, '===');
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    console.log('Row', i, ':', JSON.stringify(rows[i]));
  }
  if (rows.length > 8) {
    console.log('...');
    console.log('Last row:', JSON.stringify(rows[rows.length - 1]));
  }
}
