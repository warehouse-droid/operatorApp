import { cp, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function createCoOperatorBaseline(target) {
  await mkdir(target, { recursive: true });
  for (const name of ['src', 'public', 'test/dispatch', 'test/mbt', 'test/support']) {
    await mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await cp(name, path.join(target, name), { recursive: true });
  }
  await mkdir(path.join(target, 'tools'));
  for (const entry of await readdir('tools', { withFileTypes: true })) {
    if (entry.isFile() && ['co-completion-live.mjs', 'run-co-operator-regressions.mjs'].includes(entry.name)) {
      await cp(path.join('tools', entry.name), path.join(target, 'tools', entry.name));
    }
  }
  for (const name of ['package.json', 'package-lock.json']) {await cp(name, path.join(target, name));}
  for (const name of ['node_modules', 'migrations']) {await symlink(path.resolve(name), path.join(target, name));}
  const patch = await readFile('test/support/co-operator-baseline.patch', 'utf8');
  for (const section of patch.split(/^--- a\//m).slice(1)) {
    const filename = section.slice(0, section.indexOf('\n'));
    const location = path.join(target, filename);
    const lines = (await readFile(location, 'utf8')).split('\n');
    const hunks = section.match(/@@[^]*?(?=\n@@|$)/g) || [];
    for (const hunk of hunks.reverse()) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk);
      if (!header) {throw new Error('Invalid baseline patch header.');}
      const body = hunk.split('\n').slice(1).filter(line => /^[ +\-]/.test(line));
      const current = body.filter(line => !line.startsWith('-')).map(line => line.slice(1));
      const original = body.filter(line => !line.startsWith('+')).map(line => line.slice(1));
      const index = Number(header[1]) - 1;
      if (lines.slice(index, index + current.length).join('\n') !== current.join('\n')) {throw new Error(`Baseline patch mismatch: ${filename}:${index + 1}`);}
      lines.splice(index, current.length, ...original);
    }
    await writeFile(location, lines.join('\n'));
  }
}
