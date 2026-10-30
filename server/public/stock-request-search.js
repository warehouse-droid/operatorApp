// A list of request references is an exact OR search. Other text keeps the
// existing customer, item, vendor and order search behavior.
export function requestSearchRefs(value) {
  const refs = String(value || '').trim().split(/[\s,;]+/).filter(Boolean);
  if (!refs.length || !refs.every(ref => /^(?:STREQ|SPREQ)-[A-Z0-9_-]+$/i.test(ref))) return [];
  // Keep partial single-reference searches (for example STREQ-000) working.
  if (refs.length === 1 && !/^(?:STREQ|SPREQ)-\d{6,}$/i.test(refs[0])) return [];
  return [...new Set(refs.map(ref => ref.toUpperCase()))];
}
