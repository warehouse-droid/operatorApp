import base from '../eslint.mbt.config.js';

export default [
  ...base,
  { ...base[1], files: ['src/dispatch-plan-{fence,write,lease-repository,repository}.js', 'src/dispatch-delivery-group-repository.js', 'src/server.js',
    'public/dispatch-save-journal.js', 'tools/dispatch-save-*.mjs'],
    languageOptions: { ...base[1].languageOptions, globals: { ...base[1].languageOptions.globals,
      TextEncoder: 'readonly', Uint8Array: 'readonly', indexedDB: 'readonly' } } },
  { ...base[1], files: ['public/dispatch.js', 'public/dispatch-snapshot.js'],
    languageOptions: { ...base[1].languageOptions, sourceType: 'script', globals: { ...base[1].languageOptions.globals,
      window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', localStorage: 'readonly',
      sessionStorage: 'readonly', confirm: 'readonly', TextEncoder: 'readonly', requestAnimationFrame: 'readonly',
      cancelAnimationFrame: 'readonly', Image: 'readonly', requireDispatchLogin: 'readonly', CustomEvent: 'readonly',
      ResizeObserver: 'readonly', HTMLElement: 'readonly', IntersectionObserver: 'readonly' } } }
];
