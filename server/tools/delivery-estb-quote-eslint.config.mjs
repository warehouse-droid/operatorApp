import base from './delivery-request-eslint.config.mjs';
export default [
  ...base,
  {files:['src/netsuite-order-pdf.js','netsuite-transaction-pdf-suitelet.js'],
    languageOptions:{...base[0].languageOptions,globals:{...base[0].languageOptions.globals,define:'readonly'}},rules:base[0].rules}
];
