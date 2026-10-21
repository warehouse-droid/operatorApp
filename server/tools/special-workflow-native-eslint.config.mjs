import base from './special-workflow-link-eslint.config.mjs';
export default [...base,{languageOptions:{globals:{setImmediate:'readonly',define:'readonly'}}},
  // Existing SuiteScript catch binding is retained in the already uploaded script.
  {files:['netsuite-smart-scm-picking-ticket-restlet.js'],rules:{'no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^(?:_|lookupError$)'}]}}];
