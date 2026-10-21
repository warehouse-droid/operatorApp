// These large shared files also received concurrent Operator phone changes.
// Restrict task-only diagnostics/coverage to the functions this task edited.
const scopes = {
  'src/server.js': ['operatorSafeReturnPayload'],
  'public/operator.js': ['returnNetSuiteResultLabel', 'renderReturnSuccess', 'renderReturnPostingPolicies']
};
export function inTaskScope(file, line, source) {
  if (file === 'public/service-worker.js') {
    const text = source.split('\n')[line - 1] || '';
    return text.startsWith('const CACHE_NAME') || text.includes('/operator.js?v=');
  }
  if (file === 'src/mbt/feature-gate-catalog.js') {
    const text = source.split('\n')[line - 1] || '';
    return text.includes('OPERATOR_NETSUITE_RETURN_CREDIT_MEMO_GATE_DEFINITIONS')
      || text.includes('...[...OPERATOR_NETSUITE_GATE_DEFINITIONS');
  }
  if (!scopes[file]) { return true; }
  const lines = source.split('\n');
  return scopes[file].some(name => {
    const first = lines.findIndex(text => text.startsWith(`function ${name}(`));
    const next = lines.findIndex((text, index) => index > first && /^(?:async )?function /.test(text));
    return line >= first + 1 && (next < 0 || line <= next);
  });
}
