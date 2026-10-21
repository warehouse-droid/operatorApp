import base from '../eslint.mbt.config.js';
const browserGlobals={window:'readonly',document:'readonly',localStorage:'readonly',location:'readonly',history:'readonly',navigator:'readonly',
  MutationObserver:'readonly',EventSource:'readonly',CustomEvent:'readonly',HTMLElement:'readonly',HTMLDialogElement:'readonly',DragEvent:'readonly',DataTransfer:'readonly',File:'readonly'};
export default [
  ...base,
  {files:['src/delivery-request*.js'],languageOptions:base[0].languageOptions,rules:base[0].rules},
  {files:['public/delivery-request*.js','public/app-event-stream.js'],languageOptions:{...base[0].languageOptions,globals:{...base[0].languageOptions.globals,...browserGlobals}},rules:base[0].rules}
];
