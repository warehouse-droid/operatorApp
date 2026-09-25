import existing from '../eslint.mbt.config.js';
const common = existing[0];
export default [
  { ...common, files: ['src/aggregate-request-*.js', 'test/mbt/{unit,integration}/aggregate-request-*.test.js', 'test/support/aggregate-*.mjs', 'tools/aggregate-*.mjs'] },
  {
    ...common,
    files: ['public/aggregate-requests*.js', 'public/aggregate-requester.js', 'public/scm-stock-request-tabs.js', 'public/scm-aggregate-alert.js'],
    languageOptions: { ...common.languageOptions, sourceType: 'script', globals: {
      ...common.languageOptions.globals, window: 'readonly', document: 'readonly', location: 'readonly',
      history: 'readonly', localStorage: 'readonly', CustomEvent: 'readonly', EventSource: 'readonly', MutationObserver: 'readonly', AbortController: 'readonly'
    } },
    rules: { ...common.rules, complexity: ['error', 20] }
  }
];
