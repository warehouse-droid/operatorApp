// Compare the compiler's actual constraint, not changing inferred argument signatures.
export function typeDiagnostics(log) {
  return log.split(/\n(?=\S[^\n]*error TS\d+:)/u).flatMap(block => {
    const lines = block.trimEnd().split('\n');
    const header = lines.findIndex(line => /error TS\d+:/u.test(line));
    if (header < 0) return [];
    const cause = lines.slice(header + 1).filter(line => /^\s+\S/u.test(line));
    const first = lines[header].replace(/\(\d+,\d+\)/u, '');
    if (!cause.length) return [first];
    const identity = first.match(/^(.*?error TS\d+:)/u)?.[1];
    return [`${identity}\n${cause.join('\n')}`];
  });
}
