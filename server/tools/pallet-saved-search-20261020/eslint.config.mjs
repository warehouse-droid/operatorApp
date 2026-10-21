import base from '../../eslint.mbt.config.js';
export default [
  ...base,
  {
    ...base[0],
    files: [
      'src/config.js', 'src/netsuite.js', 'src/return-netsuite.js',
      'src/return-pallet-saved-search.js', 'src/return-policy.js', 'src/return-repository.js',
      'test/support/pallet-saved-search-fixture.js',
      'test-artifacts/pallet-saved-search-20261020/**/baseline-src/*.js'
    ]
  }
];
