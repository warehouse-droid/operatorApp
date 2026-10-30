"""Real, temporary faults in the disposable captured source, restored in finally."""

CASES = [
    ('ambiguous-write-retry', 'src/netsuite.js',
     'if (safeToRetry && isConcurrencyLimit(response.status, text) && attempt < 3)',
     'if (isConcurrencyLimit(response.status, text) && attempt < 3)',
     'test/mbt/integration/netsuite-write-retry-safety.test.js'),
    ('stale-return-clears-new-event', 'public/scm-waitlist.js',
     'if(row?.lastReturnEventId===lastReturnEventId)row.returnedUnread=false;',
     'if(row)row.returnedUnread=false;',
     'test/mbt/integration/scm-waitlist-return-race-browser.test.js'),
    ('synchronous-so-consolidation', 'src/consolidation-load-posting.js',
     '["driver_completion", "transfer_background", "sales_load_background"]',
     '["driver_completion", "transfer_background"]',
     'test/mbt/unit/consolidation-load-posting.test.js'),
    ('completed-special-edit', 'src/special-stock-request-repository.js',
     'if (special.operationally_complete || !canEditSpecialCaseLines(detail))',
     'if (!canEditSpecialCaseLines(detail))',
     'test/mbt/integration/special-case-edits-http.test.js'),
    ('secondary-login-role-lost', 'public/login.js',
     '||roles.map(role=>roleRoutes[role]).find(Boolean)', '',
     'test/mbt/unit/ui-navigation-contract.test.js'),
]


def run(checks, command, runtime, source_hash):
    original_hash = source_hash(runtime)
    results = []
    for name, relative, old, new, test in CASES:
        target = runtime / relative
        original = target.read_text()
        assert original.count(old) == 1, 'Mutation point drifted: ' + name
        try:
            target.write_text(original.replace(old, new, 1))
            code, body = checks.test_group(command, 'mutant-' + name, [test])
            counts = checks.summary(body)
            killed = code != 0 and counts['fail'] > 0 and not counts['cancelled']
            assert 'SyntaxError' not in body and 'ERR_MODULE_NOT_FOUND' not in body, 'Invalid mutant: ' + name
            row = {'name': name, 'file': relative, 'test': test, 'killed': killed,
                   'tests': counts['tests'], 'failed': counts['fail'],
                   'firstFailure': counts['failedFiles'][0]['failures'][:1] if counts['failedFiles'] else []}
            if name == 'synchronous-so-consolidation':
                property_code, property_body = checks.logged(command + [
                    'run', '--rm', '--no-deps', '-T', 'test', 'node', '--test', '--test-reporter=spec', '--test-name-pattern=properties', test],
                    'mutant-consolidation-property-only', 180)
                row['propertyAloneKilled'] = property_code != 0 and 'Counterexample:' in property_body and 'Expected values to be strictly deep-equal' in property_body
                row['propertyExitCode'] = property_code
                row['propertyFailureEvidence'] = property_body.splitlines()[:45]
                row['killed'] = row['killed'] and row['propertyAloneKilled']
            results.append(row)
            checks.emit({'stage': 'mutation', **row})
        finally:
            target.write_text(original)
            assert source_hash(runtime) == original_hash, 'Mutant restoration failed'
    return {'passed': all(row['killed'] for row in results), 'killed': sum(row['killed'] for row in results), 'total': len(results), 'results': results}
