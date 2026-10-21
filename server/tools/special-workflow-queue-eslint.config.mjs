import base from './special-workflow-native-eslint.config.mjs';
export default [...base,{languageOptions:{globals:Object.fromEntries(['history','localStorage','CSS','confirm','EventSource','CustomEvent','MessageEvent','EventTarget','AbortController'].map(name=>[name,'readonly']))}}];
