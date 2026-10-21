import base from './operator-inventory-eslint.config.mjs';
export default [{...base[0],files:[...base[0].files,'src/count-sheet-stock-refresh.js','test/count-sheet-refresh*.test.js','tools/count-sheet-refresh*.mjs','test/inventory-packed-count.test.js','test/inventory-count-review-browser.test.js','test/count-sheet-reconstruction.test.js','test/cycle-count-refresh-http.test.js']}];
