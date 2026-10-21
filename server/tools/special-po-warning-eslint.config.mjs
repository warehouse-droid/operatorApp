import base from '../eslint.mbt.config.js';
export default [{
  files: ['src/special-stock-request-repository.js', 'src/special-stock-request-service.js'],
  languageOptions: base[0].languageOptions,
  rules: { 'no-duplicate-imports': 'error', 'no-undef': 'error', 'no-unreachable': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-var': 'error', 'prefer-const': 'error' }
}, {
  files: ['public/scm-special-stock-requests.js'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'script' },
  rules: { 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-constant-condition': 'error', 'valid-typeof': 'error' }
}];
