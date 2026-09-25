import base from '../eslint.mbt.config.js';
export default [{
  files:['src/field-sales/**/*.js','public/field-sales/**/*.js','test/field-sales/**/*.{js,mjs}','tools/field-sales-*.mjs','netsuite-field-sales-restlet.js'],
  languageOptions:{...base[1].languageOptions,globals:{...base[1].languageOptions.globals,window:'readonly',document:'readonly',navigator:'readonly',location:'readonly',localStorage:'readonly',indexedDB:'readonly',self:'readonly',caches:'readonly',Request:'readonly',createImageBitmap:'readonly',google:'readonly',define:'readonly'}},
  rules:{...base[1].rules,eqeqeq:['error','always',{null:'ignore'}]}
}];
