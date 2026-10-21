import base from '../regular-stock-v2-eslint.config.mjs';
export default [...base,{languageOptions:{globals:Object.fromEntries(['EventTarget','HTMLInputElement','HTMLTextAreaElement','HTMLFormElement','HTMLElement','CustomEvent','scmStockState','salesStockState'].map(name=>[name,'readonly']))}}];
