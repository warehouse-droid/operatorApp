# Damage transfer description correction

Spec approval: existing implementation/fix authorization; additional spec review not obtained (autonomous run).

NetSuite rejected report `c419bbbe-fde7-4263-b97a-d3cf44449c44` with HTTP 400 because inventory line descriptions allow at most 40 characters. The saved report remains retryable; no transfer line was accepted.

Acceptance scenarios:

1. Creating a monthly transfer sends a description of at most 40 characters containing the complete unique report ID, regardless of SKU name length; the accepted line is reconciled and shown once in monthly review.
2. Appending to an existing transfer obeys the same limit, preserves prior lines, and a repeated processing request does not add another line.
3. Reconciliation and monthly review still recognize the original description marker if encountered, without issuing another stock movement.
4. Existing tests for ambiguous writes, mismatched quantities, duplicate markers, monthly locking, yard access, photos, count sheets, and calculator remain passing.
5. Deploy only the changed damage service over the current production image, preserve runtime settings and other services, then retry the original rejected report and verify exactly one matching NetSuite line with the saved item, quantity, UOM, and reason.

Failure model: overlong payload (boundary contract tests); lost identity or duplicate movements (reconciliation/retry and marker mutation tests); review duplicates (monthly review assertions); unrelated deployment regression (single-file image overlay and runtime/file hashes).

Setup: existing Node test runner, isolated PostgreSQL/Docker runner, c8, eslint and TypeScript. No new dependencies or commits. Persist checks, release script, and evidence in the repository. Run feature tests, repository regression comparison, static checks, coverage, three targeted mutants, and repeat tests in a different order. No schema change. Live recovery is restricted to the user's already-submitted report.
