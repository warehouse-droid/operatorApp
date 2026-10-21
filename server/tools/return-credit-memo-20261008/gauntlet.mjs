import { run } from './check.mjs';
const task = 'tools/return-credit-memo-20261008/';
run('final-static', [task + 'check.mjs', 'static']);
run('final-regression', [task + 'check.mjs', 'regression']);
run('final-coverage', [task + 'check.mjs', 'coverage']);
run('final-browser', [task + 'browser.mjs']);
run('final-mutations', [task + 'mutations.mjs']);
run('final-versions', [task + 'check.mjs', 'versions']);
