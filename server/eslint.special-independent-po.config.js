export default [{
  files:['src/special-stock-purchase-*.js','public/special-stock-po-editor.js'],
  languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{document:'readonly',crypto:'readonly',setTimeout:'readonly',clearTimeout:'readonly'}},
  rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_'}],'no-undef':'error','no-unreachable':'error',
    'no-constant-condition':'error','no-var':'error','prefer-const':'error','eqeqeq':['error','smart'],
    'max-depth':['error',4],'complexity':['error',20]}
}];
