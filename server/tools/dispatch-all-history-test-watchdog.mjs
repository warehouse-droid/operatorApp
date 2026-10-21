import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const timeoutSeconds = Number(process.argv[2] || 120);
assert.ok(timeoutSeconds >= 120 && timeoutSeconds <= 600);
// Runs inside one disposable test container. A timed-out test is a failure,
// and the existing per-file runner still removes its isolated database.
setInterval(() => {
  const processList = spawnSync('ps',['-o','pid,ppid,etimes,args'],{encoding: 'utf8'});
  const rows = processList.stdout.split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
    return match ? {pid: Number(match[1]),parent: Number(match[2]),seconds: Number(match[3]),args: match[4]} : null;
  }).filter(Boolean);
  for (const row of rows) {
    if (row.seconds < timeoutSeconds || !/\/node --test --test-concurrency=1 --test-reporter=spec \/app\/test\//u.test(row.args)) { continue; }
    console.error(JSON.stringify({event: 'isolated_test_timeout',seconds: row.seconds,pid: row.pid,test: row.args}));
    const descendants = new Set([row.pid]);
    for (let previousSize = 0; previousSize !== descendants.size;) {
      previousSize = descendants.size;
      for (const child of rows) { if (descendants.has(child.parent)) { descendants.add(child.pid); } }
    }
    for (const pid of [...descendants].reverse()) {
      try { process.kill(pid,'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') { throw error; } }
    }
  }
},1000);
