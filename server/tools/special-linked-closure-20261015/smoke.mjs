import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.MBT_TEST_ISOLATED, '1');
const app = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: '3199' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
app.stdout.on('data', data => { output += data; });
app.stderr.on('data', data => { output += data; });
const ended = once(app, 'exit');
try {
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    assert.equal(app.exitCode, null, output.slice(-3000));
    try {
      const response = await fetch('http://127.0.0.1:3199/health');
      if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
    } catch { /* Wait until the server binds its isolated port. */ }
    await delay(250);
  }
  assert.ok(healthy, output.slice(-3000));
  console.log(JSON.stringify({ applicationStarted: true, health: true, liveClosureActions: 0 }));
} finally {
  app.kill('SIGTERM');
  await Promise.race([ended, delay(3000)]);
  if (app.exitCode === null && app.signalCode === null) { app.kill('SIGKILL'); await ended; }
}
