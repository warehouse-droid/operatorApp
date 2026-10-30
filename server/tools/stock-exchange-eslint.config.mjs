import base from '../eslint.mbt.config.js';
export default [{...base[0],files:['src/stock-exchange-*.js','test/mbt/**/stock-exchange*.test.js','tools/stock-exchange*.mjs'],
  languageOptions:{...base[0].languageOptions,globals:{...base[0].languageOptions.globals,window:'readonly',document:'readonly'}}}];
