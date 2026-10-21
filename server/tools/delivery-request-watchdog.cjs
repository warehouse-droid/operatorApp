// Bound stalled regression files in disposable test containers only.
const fs = require('node:fs');
if (process.env.MBT_TEST_ISOLATED !== '1') throw new Error('The watchdog requires the isolated test environment.');
const limitMs = Number(process.argv[2] || 120000), log = process.argv[3];
const observed = new Map();
function processes() {
  const rows = [];
  for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
      const status = fs.readFileSync(`/proc/${pid}/status`,'utf8');
      rows.push({ pid:Number(pid),parent:Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),command });
    } catch { /* The process exited between reads. */ }
  }
  return rows;
}
function terminateTree(root,rows) {
  for (const child of rows.filter(row => row.parent === root)) terminateTree(child.pid,rows);
  try { process.kill(root,'SIGKILL'); } catch { /* Already exited. */ }
}
setInterval(() => {
  const rows = processes(), live = new Set();
  for (const row of rows.filter(item => item.command[1] === '--test')) {
    live.add(row.pid);
    if (!observed.has(row.pid)) observed.set(row.pid,Date.now());
    if (Date.now()-observed.get(row.pid) >= limitMs) {
      const note = `${new Date().toISOString()} TIMEOUT ${limitMs}ms ${row.command.at(-2)}\n`;
      if (log) fs.appendFileSync(log,note);
      terminateTree(row.pid,rows);
      observed.delete(row.pid);
    }
  }
  for (const pid of observed.keys()) if (!live.has(pid)) observed.delete(pid);
},1000);
