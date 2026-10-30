module.exports = [{
  files: ['ppa_*.js'],
  languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { define: 'readonly' } },
  rules: {
    complexity: ['error', 12], curly: ['error', 'all'], eqeqeq: ['error', 'always'],
    'max-depth': ['error', 4], 'no-constant-condition': 'error', 'no-undef': 'error',
    'no-unreachable': 'error', 'no-unused-vars': 'error', 'no-var': 'error', 'prefer-const': 'error'
  }
}];
