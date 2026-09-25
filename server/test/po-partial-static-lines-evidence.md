# POB03684 partial receipt verification

Spec: [po-partial-static-lines-spec.md](po-partial-static-lines-spec.md).
Tier 3. Spec approval was not obtained (autonomous run); the user authorized
fixing and deploying the receiving failure. No live receipt is submitted by
these checks.

The failed command `de870108-fe99-4ee0-a19d-bb86b1631863` contained 16 item rows.
The two selected REST line IDs and quantities were correct. Thirteen unselected
rows were already fully received in NetSuite, while the local receipt counters
were stale. Those rows no longer belong to its open receipt sublist. A read-only
external-ID lookup found no transaction for this failed attempt.

The correction reads the current PO once while constructing the durable draft,
matches its exact stored REST line and item IDs, and refreshes availability.
Completed or closed unselected rows are omitted; open unselected rows stay
explicitly false. Unknown open rows, missing selected rows, identity changes,
ambiguous identities, invalid counters and failed reads prevent drafting.
Selected quantities, PO split lineage, references, idempotency, the transform
adapter and prior display corrections are preserved.

| Requirement | Evidence |
| --- | --- |
| Exact incident payload | Real SQL fixture and real target/domain code produce only `6=108`, `29=304`, and `33=false` |
| Completed, closed, missing and partially received rows | Focused examples check the exact remaining deselections |
| Fail before posting on uncertain identity or availability | Missing/duplicate/changed/unknown rows, malformed values and injected read failure |
| Production wiring | Actual exported resolver calls one mocked NetSuite GET, with no transform permitted |
| Split parent and selected quantities | Split fixture resolves the positive parent; quantities are never silently reduced |
| Input order and current counters | 40 generated scenarios, seed `36840922`, checking exact selections and deselections |
| Recovery, direct SO/TO and existing receiving | Adjacent target, domain, service, identity, allocation and HTTP timing suites |
| Live order | Candidate imported in memory; read-only transaction builds the same three-row draft using real NetSuite data |

Artifacts are under `server/test-artifacts/po-partial-static-lines/`.
Deployment artifacts are under
`server/test-artifacts/po-partial-static-lines-deployment-20260922/`.

- RED: the original six regression tests failed against the saved implementation
  with payload/read-count/assertion failures. The malformed-counter extension
  also failed before tightening counter validation (`red.log`, `counter-red.log`).
- GREEN: eight incident tests and all adjacent checks pass, **101 tests total**.
  The seeded shuffled run also passes.
- Read-only candidate replay at **2026-09-22 21:22:03 UTC** confirms exactly
  selected 108 and 304 SQFT, deselected line 33, and no receipt for the failed
  external ID. The failed command remains unchanged.
- Mutation checks: **5/5** deliberate faults killed by the full incident suite,
  and **5/5** killed by its property test alone. Loader mutations never alter
  runtime files on disk; source hashes match before and after the gauntlet.
- c8/diff coverage: **55/55 changed lines** and **40/40 changed-location
  branches** covered (helper 47 lines/34 branches; resolver 8 lines/6 branches).
- Syntax, lint, types and secret scan: **0 new findings**. The unchanged
  imported graph has **7,772 existing TypeScript diagnostics**; the new helper
  has zero diagnostics. Existing-file lint/type results are compared with an
  equivalent saved-source baseline.
- Tools: Node 20.20.2, fast-check 4.9.0, c8 12.0.0, ESLint 10.8.0 and TypeScript
  7.0.2 in `field-sales-check-2941306:latest` (image
  `sha256:a213a201d54066121bc474fd418fe25417cc595bfc4be21abd3cefcd0cd6e6a2`).
- Exact captured-live candidate: **101 receiving tests**, **3 page-confirmation
  contracts**, and **35 Aggregate/Sales-map tests** pass. Its two runtime files
  match the checked workspace; all other live files are preserved.
  One historical cache-literal contract is skipped by the focused selection
  and remains included in the full existing-failure comparison.
- A read-only release check found the failed command still `failed` and
  **0 active claims**, so a fresh request ID will not be blocked by it.
- Full regression: **570 files, 3,029 tests, 3,003 passes, 25 existing failures,
  1 existing skip, 0 new failures** against the recorded baseline. Both runtime
  file hashes match the focused run and remained unchanged throughout the full
  run. Existing failures were neither hidden nor changed.
- Deployed at **2026-09-22 21:37:53 UTC** as
  `mbbs-operator-app:po-partial-static-lines-20260922-v1`, image
  `sha256:72ad4aff9f6954ce658b154517f3962d0a9c4f08d07dad6c45613afdef8726e2`.
  The installed resolver's read-only replay again produced exactly lines 6 and
  29 selected and line 33 deselected. Local and public health returned **200**;
  both installed file hashes match the candidate. Configuration, other services,
  incident quantities and split ledgers are unchanged. Preflight had **0** active
  postings, fulfillments or Dispatch editors after the user confirmed exiting
  Edit Mode. The failed command still has no NetSuite receipt and is unchanged.
  Disposable test containers/networks were removed; the previous live image is
  retained as the deployment rollback target.

Static validation initially compared an incomplete temporary baseline that
omitted an imported public JavaScript module. Copying the unchanged public
sources into that baseline made the comparison equivalent; application code
and type assertions were not weakened. The first live probe used `/api/health`
instead of the app's `/health`; correcting the probe path resolved its 404.

Reproduce with `python3 server/tools/po-partial-static-lines-gauntlet.py` from
the workspace root, using the existing isolated test image and PostgreSQL.
The full comparison uses `receiving-split-balance-existing-baseline.json`.
The read-only live replay is `python3 server/tools/po-partial-static-lines-replay.py`;
add `--deployed` to use the installed module instead of importing the candidate.

There is no live end-to-end receipt submission in this evidence. The user must
start a fresh Receive attempt after deployment: the existing failed command and
its immutable payload are retained for recovery and audit. No operational data
repair, migration, credentials or dependency changes are included.
