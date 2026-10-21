import { run } from './check.mjs';
const task = 'tools/return-pallet-balance-sync-20261008';
run('final-static', [task + '/check.mjs', 'static']);
run('final-regression', [task + '/check.mjs', 'regression']);
run('final-coverage', [task + '/check.mjs', 'coverage']);
run('final-mutations', [task + '/mutations.mjs']);
run('final-audit', [task + '/audit.mjs']);
run('versions', [task + '/check.mjs', 'versions']);
