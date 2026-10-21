import base from '../../eslint.mbt.config.js';
export default [
  ...base,
  { ...base[0], files: ['test-artifacts/return-pallet-accounting-20261020/**/query-static.mjs'] }
];
