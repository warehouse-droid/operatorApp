import base from '../eslint.mbt.config.js';
export default [{
  ...base[1],
  files:['src/inventory-*.js','src/count-sheet-repository.js','src/operator-inventory-router.js','public/operator-inventory.js','public/counting-calculator.js','public/control-count-sheets.js','test/operator-inventory-*.test.js','tools/operator-inventory-*.mjs'],
  languageOptions:{...base[1].languageOptions,globals:{...base[1].languageOptions.globals,
    window:'readonly',document:'readonly',localStorage:'readonly',navigator:'readonly',requestAnimationFrame:'readonly'}}
}];
