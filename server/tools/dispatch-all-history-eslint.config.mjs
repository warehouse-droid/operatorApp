import base from '../eslint.mbt.config.js';
export default [...base, {...base[1],files: [
  'src/dispatch-history-mode.js','src/dispatch-load-assignment.js','src/order-dependency-repository.js',
  'src/dispatch-pickup-visits.js',
  'src/dispatch-historical-order-snapshots.js',
  'src/dispatch-planner-v2-repository.js','src/scm-dependency-preview-service.js',
  'test/dispatch/integration/to-dependency-packing-independent.test.js',
  'test/dispatch/integration/retained-history-save.test.js',
  'test/dispatch/integration/historical-missing-order-snapshot.test.js',
  'test/dispatch/unit/historical-replay-fixture-classification.test.js',
  'test/dispatch/unit/historical-group-pickups.test.js',
  'test/dispatch/unit/executed-prefix-historical-reflexivity.test.js',
  'test/dispatch/property/historical-planning-safety.property.test.js',
  'tools/dispatch-all-history-*.mjs'
]}];
