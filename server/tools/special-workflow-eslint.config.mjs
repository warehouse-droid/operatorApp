export default [{
  files: ['**/*.js','**/*.mjs'],
  languageOptions: { ecmaVersion:'latest',sourceType:'module', globals:Object.fromEntries(['window','document','location','crypto','fetch','FormData','URLSearchParams','URL','setTimeout','clearTimeout','setInterval','clearInterval','console','process','Buffer','requireDispatchLogin'].map(name=>[name,'readonly'])) },
  rules: { 'no-undef':'error','no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}], 'no-unreachable':'error','no-dupe-keys':'error','no-duplicate-imports':'error','no-constant-condition':'error','no-var':'error','prefer-const':'error' }
}];
