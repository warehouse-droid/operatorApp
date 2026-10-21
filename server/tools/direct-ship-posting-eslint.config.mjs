import base from '../eslint.mbt.config.js';
export default [...base,{...base[0],files:['src/direct-po-auto-receipt*.js','src/netsuite-fulfillable-items.js']}];
