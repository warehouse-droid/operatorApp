import base from '../eslint.mbt.config.js';
export default [{
  ...base[1],
  files: ['src/**/*.js','public/**/*.js','test/dispatch/**/*.js','tools/sor-*.mjs'],
  languageOptions: {...base[1].languageOptions,globals:{...base[1].languageOptions.globals,
    window:'readonly',document:'readonly',navigator:'readonly',localStorage:'readonly',sessionStorage:'readonly',
    self:'readonly',caches:'readonly',location:'readonly',indexedDB:'readonly',Image:'readonly',FileReader:'readonly',File:'readonly',
    alert:'readonly',confirm:'readonly',prompt:'readonly',getComputedStyle:'readonly',requestAnimationFrame:'readonly',
    cancelAnimationFrame:'readonly',matchMedia:'readonly',HTMLElement:'readonly',atob:'readonly',btoa:'readonly',
    TextDecoder:'readonly',TextEncoder:'readonly',Notification:'readonly',EventSource:'readonly',ResizeObserver:'readonly',MutationObserver:'readonly',
    requestIdleCallback:'readonly',DOMParser:'readonly',HTMLInputElement:'readonly',HTMLSelectElement:'readonly',HTMLTextAreaElement:'readonly'}}
}];
