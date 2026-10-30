import base from '../eslint.mbt.config.js';
import dispatch from './dispatch-save-eslint.config.mjs';

export default [...dispatch, { ...base[1], files: ['src/dispatch-source-refresh.js', 'src/dispatch-executed-order-review-repository.js',
  'test/dispatch/frontend/dispatch-source-refresh.test.js', 'test/dispatch/property/dispatch-source-refresh.property.test.js',
  'tools/dispatch-source-save-*.mjs'] }];
