import base from './dispatch-save-eslint.config.mjs';
import dispatch from '../eslint.mbt.config.js';
export default [...base, { ...dispatch[1],
  files: ['src/dispatch-plan-maintenance*.js', 'src/delivery-repository.js', 'src/dispatch-repository.js',
    'src/dispatch-co-group-identity-repository.js', 'tools/order-update-save-*.mjs']
}];
