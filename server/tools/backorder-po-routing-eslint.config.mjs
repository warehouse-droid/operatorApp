import project from '../eslint.mbt.config.js';
export default [...project,{
  files:['public/backorder-po-routing.js','public/special-stock-po-routing.js','src/backorder-request-routes.js','src/special-stock-purchase-order-routing.js'],
  languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{Element:'readonly',FormData:'readonly',HTMLFormElement:'readonly',HTMLButtonElement:'readonly',HTMLInputElement:'readonly',HTMLSelectElement:'readonly',HTMLTextAreaElement:'readonly'}},
  rules:{'no-undef':'error','no-unreachable':'error','no-dupe-args':'error','no-constant-condition':'error','no-unused-vars':'error'}
}];
