import base from './special-workflow-eslint.config.mjs';
export default [...base, { languageOptions: { globals: { AbortSignal: 'readonly' } } }];
