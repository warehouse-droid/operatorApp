import base from '../../eslint.mbt.config.js';
const globals={...base[0].languageOptions.globals,document:'readonly',window:'readonly',location:'readonly',
  localStorage:'readonly',history:'readonly',navigator:'readonly',matchMedia:'readonly',MutationObserver:'readonly'};
export default [{files:['src/mbr/**/*.js','public/mbr/**/*.js','test/mbr/**/*.{js,mjs}','tools/mbr-contract-*.mjs'],
  languageOptions:{ecmaVersion:'latest',sourceType:'module',globals},rules:base[0].rules}];
