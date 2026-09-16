# IR receiving reference — 2026-09-16

Spec approval: not obtained (autonomous run). The user requested identifying the
second field on IR14634, writing the PO reference to both fields on IR posting,
and deployment after regression passes. Tier 3: a small payload change on an
inventory transaction boundary. No separate approval gate is required by this
autonomous instruction.

## Observed account contract

Read-only REST inspection of IR14634 (internal ID 993562) found both `memo` and
`custbody9` equal to `SN1400333`, with Created From PO 936958 / POB03658.
The account's itemReceipt JSON metadata identifies `custbody9` as **Ref No**,
a nullable custom string field. Evidence: test-artifacts/ir-po-reference/live-field.json.

## Executable acceptance criteria

1. Split PO SN1400333 posts its receiving reference to both `memo` and
   `custbody9`, through the real target resolver, draft and NetSuite adapter.
   The transform still targets PO 936958 / POB03658 and exactly the selected
   source lines and native quantities; completed/deselected behavior stays.
2. A normal PO uses its own stored PO reference for both fields. Whitespace
   trims identically; vendor memo and parent PO reference never replace a split
   reference. Transfer IRs also mirror their existing receiving-reference memo.
3. Missing/blank references omit both fields. IF payloads never gain either
   receipt field, even if a caller provides a memo or custbody9.
4. Both fields are included before immutable payload/input hashes are computed.
   Different references change both hashes; canonical ordering is deterministic.
   Duplicate same-reference targets aggregate; conflicting references fail.
5. Generated and hostile references round-trip through JSON unchanged except
   existing whitespace normalization. Neither arbitrary fields nor injected
   custbody9 override the server-owned reference. Quantity bounds, source IDs,
   external IDs and unselected lines are unchanged.
6. Existing stored commands/receipts are not edited or replayed, and verification
   performs no live NetSuite write. Existing posting retries, reconciliation,
   timing, background photos, receiving and consolidation regressions remain.
7. Automatic photo camera change already prepared remains part of this release;
   all 26 UI contract tests and 11 browser checks must pass on packaged assets.

## Failure model and setup

- Wrong source/reference: resolver-to-adapter boundary tests, explicit split and
  normal examples, property/adversarial inputs, omission/substitution mutants.
- Quantity/line or IF regression: existing SN1400333, posting domain, service,
  adapter, reconciliation/property/adversarial suites and full suite comparison.
- Broken immutable retry identity: canonical payload/hash assertions and existing
  service/repository/concurrency tests; stored commands remain untouched.
- Unsupported account field: existing receipt + live account metadata GET.
  Actual remote acceptance of a newly created IR remains unverified without a
  real business receipt; no receipt is created merely for testing.

Use installed Docker Node20, fast-check, c8, ESLint and TypeScript images,
disposable isolated PostgreSQL, and the existing deployment flow. Add tests,
scripts, reversible source manifest and evidence only; no dependencies,
migrations or commits. Preserve the dirty worktree. Run RED, focused/property,
coverage, mutants, type/lint baseline comparisons, full npm test on baseline and
candidate, and real endpoint/boundary tests. Deploy only verified runtime files
with rollback retained and health/hash checks. No changes to live business data.
