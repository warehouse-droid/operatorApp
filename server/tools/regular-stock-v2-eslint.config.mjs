import base from './special-workflow-eslint.config.mjs';
export default [...base,{languageOptions:{globals:Object.fromEntries(['AbortController','AbortSignal','MutationObserver','EventSource','Event','Response','CSS','localStorage','history','confirm','setImmediate','structuredClone'].map(name=>[name,'readonly']))}},
  // These classic scripts share the declarations provided by scm-smart.js.
  {files:['public/scm-smart-proposals.js'],languageOptions:{globals:Object.fromEntries(['smartEscape','smartNumber','smartCanWrite','smartScmApp','smartWork','smartApi','smartState','smartLoadBootstrap'].map(name=>[name,'readonly']))}}
];
