export default [{
  files:['src/stock-check/**/*.js','public/scm-stock-check*.js','test/mbt/**/*stock-check*.{js,mjs}','tools/*stock-check*.mjs'],
  languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{
    Buffer:'readonly',process:'readonly',console:'readonly',setTimeout:'readonly',clearTimeout:'readonly',
    setInterval:'readonly',clearInterval:'readonly',URL:'readonly',URLSearchParams:'readonly',
    AbortController:'readonly',AbortSignal:'readonly',structuredClone:'readonly',fetch:'readonly',document:'readonly',window:'readonly',
    location:'readonly',navigator:'readonly',localStorage:'readonly',MBBS_I18N:'readonly',requireDispatchLogin:'readonly',
    dispatchLogout:'readonly',DOMParser:'readonly',FormData:'readonly',Event:'readonly',Blob:'readonly',
    requestAnimationFrame:'readonly',Image:'readonly',HTMLElement:'readonly',MutationObserver:'readonly',queueMicrotask:'readonly'
  }},
  rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}],
    'no-undef':'error','no-unreachable':'error','no-duplicate-imports':'error','eqeqeq':'error',
    'curly':'error','prefer-const':'error','complexity':['error',16],'max-depth':['error',5]}
}];
