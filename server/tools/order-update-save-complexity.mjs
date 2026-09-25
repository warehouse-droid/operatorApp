import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'espree';
import { runtimeFiles } from './order-update-save-files.mjs';

const root = 'test-artifacts/order-update-save';
const files = runtimeFiles;
const relocations = { performDispatchPlanConfirmation: 'confirmCurrentPlanAtomic',
  performDispatchDependencyMutation: 'runAtomicDispatchDependencyMutation' };
function declarations(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });
  return tree.body.map(node => node.declaration || node).filter(node => node.type === 'FunctionDeclaration');
}
function decisions(node, root = node) {
  if (!node || typeof node !== 'object') return 0;
  if (node !== root && /Function/.test(node.type || '')) return 0;
  let count = ['IfStatement', 'ConditionalExpression', 'CatchClause', 'ForStatement', 'ForInStatement',
    'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'LogicalExpression'].includes(node.type) ? 1 : 0;
  if (node.type === 'SwitchCase' && node.test) count++;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) count += value.reduce((n, item) => n + decisions(item, root), 0);
    else if (value && typeof value === 'object') count += decisions(value, root);
  }
  return count;
}
const report = { budget: { newNamedFunctionLines: 80, newNamedFunctionDecisions: 24 }, functions: [],
  scope: 'New named helpers; pre-existing large route callbacks remain covered by regression lint and execution tests.' };
for (const file of files) {
  const before = new Map(declarations(await readFile(`${root}/baseline/${file}`, 'utf8').catch(() => '')).map(node => [node.id.name, node]));
  for (const node of declarations(await readFile(file, 'utf8'))) {
    const name = node.id.name;
    if (before.has(name)) continue;
    const previous = before.get(relocations[name]);
    report.functions.push({ file, name, lines: node.loc.end.line - node.loc.start.line + 1,
      decisions: decisions(node), ...(previous ? { relocatedFrom: relocations[name] } : {}) });
  }
}
report.exceeded = report.functions.filter(row => !row.relocatedFrom &&
  (row.lines > report.budget.newNamedFunctionLines || row.decisions > report.budget.newNamedFunctionDecisions));
await writeFile(`${root}/complexity.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
assert.equal(report.exceeded.length, 0, 'New save helper exceeds the complexity budget');
