import base from '../eslint.mbt.config.js';
export default [{
  files: ['src/dispatch-repository.js','src/order-dependency-repository.js','src/dispatch-po-route-projection.js'],
  languageOptions: base[0].languageOptions,
  rules: { 'no-duplicate-imports':'error','no-undef':'error','no-unreachable':'error',
    'no-unused-vars':['error',{argsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_',varsIgnorePattern:'^_'}],
    'no-var':'error','prefer-const':'error' }
},{
  files: ['public/dispatch.js'],
  languageOptions: {ecmaVersion:'latest',sourceType:'script'},
  rules: {'no-unreachable':'error','no-dupe-keys':'error','no-constant-condition':'error','valid-typeof':'error'}
}];
