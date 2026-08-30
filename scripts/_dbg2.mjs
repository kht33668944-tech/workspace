import { makeCoupangOptionLookup, buildOptionFor } from "./coupang-option-map.mjs";
const L = makeCoupangOptionLookup();
const spec = { quantity: 12, quantityUnit: "개", unitValue: "", unitType: "",
  counts: [{ n: 250, unit: "매" }, { n: 12, unit: "개" }], length: "" };
const cat = L.lookup("세제/제지/일용잡화 > 화장지/제지류 > 각티슈/미용티슈");
console.log("cat:", cat?.path, JSON.stringify(cat?.options));
console.log("opt:", JSON.stringify(buildOptionFor(cat, spec, {})));
const cat2 = L.lookup("세제/제지/일용잡화 > 화장지/제지류 > 롤/고급,천연/3겹이상");
console.log("cat2:", cat2?.path, JSON.stringify(cat2?.options));
console.log("opt2:", JSON.stringify(buildOptionFor(cat2, { quantity: 1, quantityUnit: "개", unitValue: "", unitType: "", counts: [{ n: 48, unit: "롤" }], length: "30m" }, {})));
