import base from '../eslint.mbt.config.js';
export default [...base,{...base[1],files:[
  'src/driver-repository.js','src/dispatch-load-assignment.js','src/dispatch-retained-link-manifests.js',
  'public/dispatch.js','test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/integration/linked-driver-stop-content.test.js',
  'tools/dispatch-history-cargo-*.mjs'
],rules:{...base[1].rules,complexity:'off','max-depth':'off'}},
{files:['public/dispatch.js'],languageOptions:{globals:{window:'readonly',document:'readonly',navigator:'readonly',google:'readonly',alert:'readonly',confirm:'readonly',requestAnimationFrame:'readonly',cancelAnimationFrame:'readonly',localStorage:'readonly',MutationObserver:'readonly',IntersectionObserver:'readonly'}}}];
