import base from '../eslint.mbt.config.js';
export default [{...base[0],files:['src/**/*.js','public/operator.js','public/service-worker.js','test/mbt/**/*.{js,mjs}','tools/**/*.mjs'],
  languageOptions:{...base[0].languageOptions,globals:{...base[0].languageOptions.globals,window:'readonly',document:'readonly',
    navigator:'readonly',localStorage:'readonly',sessionStorage:'readonly',Image:'readonly',HTMLElement:'readonly',HTMLInputElement:'readonly',
    HTMLSelectElement:'readonly',HTMLTextAreaElement:'readonly',HTMLVideoElement:'readonly',HTMLCanvasElement:'readonly',Event:'readonly',
    CustomEvent:'readonly',EventSource:'readonly',requestAnimationFrame:'readonly',cancelAnimationFrame:'readonly',File:'readonly',
    FileReader:'readonly',ResizeObserver:'readonly',getComputedStyle:'readonly',self:'readonly',caches:'readonly',Request:'readonly',
    MediaRecorder:'readonly',confirm:'readonly',alert:'readonly',Audio:'readonly'}}}];
