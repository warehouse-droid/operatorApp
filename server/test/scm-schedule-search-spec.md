# PO/TO schedule search for Sales and Dispatch

Tier 3: changing read visibility. Spec approval: not obtained (autonomous run).
The user's correction explicitly requires excluding Hold. Criterion 1 below is
amended by that correction: Hold is excluded everywhere in this search mode.

Acceptance criteria, recorded before implementation:

1. With any selected view and conflicting column filters, a nonblank global
   search on Sales or Dispatch returns every matching non-Hold schedule row.
   Include normal POs, special POs, Blanket POs, TOs, VRMAs, Completed,
   Cancelled, inactive completed orders, and closed order families.
2. Hold remains excluded, including a Hold status applied by reconciliation.
3. Clearing search, including entering only whitespace, restores normal
   browsing rules and the user's selected filters. Searching does not overwrite
   saved preferences. SCM's existing structured-search behavior stays intact.
4. Sales results remain limited to the account's authorized yards, including
   combined-yard routes. Authentication, API role checks, reconciliation detail
   access, and order write/planning permissions remain intact. A query flag alone
   cannot reveal restricted rows when no search is present or grant a Yard
   Manager the Dispatch search policy.
5. Matching stays case-insensitive and supports partial order references,
   vendors, content, and the existing search fields. No-match searches are empty.
6. Both browser surfaces render the unrestricted results, exclude Hold, and
   return to their selected filters when search is cleared.

Failure model and verification:

- Hidden server or browser gates silently drop results: real PostgreSQL/HTTP
  fixture tests plus browser execution, across types/statuses/views.
- Hold leaks after reconciliation: tests of final response filtering and UI.
- Expanded visibility leaks other Sales yards or bypasses authentication:
  adversarial HTTP tests and manual mutants of authorization/yard checks.
- Empty or whitespace search broadens normal browsing: policy properties,
  API tests, browser tests, and a mutant that removes the nonblank condition.
- Unrelated workspace edits are overwritten: snapshot the current files,
  produce a task-only patch, and compare source hashes before/after mutations.
- Tests affect the live host or leave data: standard isolated Compose,
  mbbs-tests.slice and bounded resources, pre-registered finally teardown,
  docker ps and docker ps -a verification, production /health check.

Setup: use existing Node, PostgreSQL, Playwright, fast-check, c8, ESLint and
TypeScript. Add no dependencies and make no commits. Add tests and a reproducible
runner under tools/scm-schedule-search-20261014 and keep evidence under the
existing test-artifacts folder. Compare the default test suite and static checks
against the current dirty-workspace baseline; report pre-existing failures.
No production deployment is included without existing session authorization.

Verification amendment: the unmodified default repository suite exceeded the
900-second test budget, with aggregate-request-browser.test.js still running.
Keep its failed baseline/cleanup evidence and mark the full default-suite
comparison unverified. Run the complete affected schedule regression set;
unrelated test repairs are outside this change. The stale cache-version
assertion also failed in the original source baseline and remains reported.

Deployment authorization: the user explicitly requested "deploy" on 2026-10-14.
Merge only the five verified search runtime files onto the current live image,
preserve unrelated live updates, verify the merged candidate in the bounded
disposable environment, recreate only the application container, and verify
health, served assets and the existing authentication boundary. Keep the prior
image available for rollback. Leave production schema and data intact.

Cross-yard amendment, 2026-10-14: the user reported that the Sales account for
3445 searching EKO70S must also find POs to 2967, 150 and 12441. This supersedes
criterion 4's yard restriction for nonblank global schedule searches. Sales
search must span every yard as well as every non-Hold status and order type;
clearing search or entering only whitespace must restore the account's normal
yard scope. Authentication, reconciliation-detail and write permissions stay
as specified. The cross-yard result is intentional search visibility.

Reproduce the reported case with EKO70S item/SKU fixtures: a TO to 3445, POs to
2967, 150 and 12441, and Hold POs to those yards. Verify exact API and browser
results under a Sales account assigned only to 3445, with conflicting saved
filters; verify that clearing search restores those filters and yard scope.
Mutation checks must detect restoration of the unconditional yard restriction,
removal of yard restriction during ordinary browsing, and an inverted search
condition. Deploy this correction under the existing deployment authorization,
merging only the Sales route delta onto the latest live image and preserving
any intervening application updates.
