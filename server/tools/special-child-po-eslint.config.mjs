import project from '../eslint.mbt.config.js';
export default [...project,{
  files:['src/special-stock-purchase-order-routing.js','public/special-stock-po-routing.js','src/scm-schedule-special-order.js'],
  languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{HTMLInputElement:'readonly',HTMLSelectElement:'readonly',HTMLTextAreaElement:'readonly'}},
  rules:{'no-undef':'error','no-unreachable':'error','no-dupe-args':'error','no-constant-condition':'error'}
}];
