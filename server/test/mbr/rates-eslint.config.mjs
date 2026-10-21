import base from './eslint.config.mjs';
export default [...base,{...base[0],files:['tools/mbr-rates-*.mjs']}];
