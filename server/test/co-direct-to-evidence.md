# CO direct TO cargo and Packed visibility — evidence

Spec: [co-direct-to-spec.md](co-direct-to-spec.md). Tier 3. Spec approval was not
obtained (autonomous run); the user explicitly chose 1 pallet on TOB01102 and 6
on the CO. Human review of the spec did not occur. These checks cover the stated
scenarios, not every possible CO workflow.

The fix reconciles direct TO allocations into the independent CO manifest while
retaining its original requirements for reversal. Operator lists confirmed,
ownerless packing in Packed and remaining quantities in Active. Packing on the
five unrelated CO lines is preserved exactly.

| Constraint | Executable evidence |
| --- | --- |
| Full/partial TO allocation, packing preservation, unchanged SO/TO demand | `co-direct-to.test.js`: first case and exact row comparisons; live guarded rehearsal |
| Creation after linking, repeated source/CO refresh, idempotent receipt | creation/refresh case; generated idempotence property |
| Unlink and mode restoration; yard replenishment unchanged | mode-change and replenishment cases |
| Packed and Active membership, correct remainder, load validation | repository list/detail cases; Chromium visibility check |
| Owned drafts and executed CO protection | owned preparation, four terminal-state cases |
| Atomic rejection of changes affecting packing | stale legacy allocation case checks full rollback |
| Concurrent packing | real PostgreSQL operator-lock barrier; mutex-removal mutant killed |
| Source identity and empty canonical manifest | ambiguous identity rejection; stale Dispatch projection case |
| Quantity conservation and hostile inputs | 100 generated cases, finite/negative quantity checks |

All named CO cases are in `test/dispatch/integration/co-direct-to.test.js`.
The browser harness uses the real Operator visibility functions and repository
list/detail results in Chromium; it does not claim an authenticated mobile-device
end-to-end session.

Final verification, against the runtime hashes below:

- Initial RED and reproducible baseline RED: 5 tests, 4 assertion failures for
  the reported defects, 1 existing draft-protection case passing.
- Focused and adjacent suite: **140/140 passing**. Reverse file order: all 9
  files passing. No existing assertions were weakened or skipped.
- Full suite, baseline and final: **505 files, 2,580 tests; 2,578 passing,
  1 skipped, 1 existing failure**. The failure is `P3.12: browser specs share one
  worker-owned database-pool lifecycle`. Zero new failures.
- TypeScript: **233 existing diagnostics, zero new diagnostics**.
- Scoped ESLint and JavaScript syntax checks: passing, zero warnings. New
  functions obey the repository's complexity limit of 12.
- Changed executable lines: **138/138 executed**. New-module branch coverage:
  **64/66**; two default-value fallbacks were not independently exercised.
- Manual mutation checks: **9/9 killed**. Property-only reruns kill the three
  arithmetic/idempotence mutants. The six database/visibility mutants survive
  the math-only properties and are killed by the behavioral suite; those
  properties do not establish database or UI safety.
- Chromium: Packed lists five packed lines; Active lists one PALLET line with
  quantity 6. Screenshots and machine results are in `test-artifacts/co-direct-to`.
- Secret scan: **19 new paths plus changed-line diff checked**, no high-confidence
  findings. No dependencies, migrations, or runtime network capabilities added.
  Dependency audit/license review is not applicable to an unchanged dependency set.
- Read-only live Packed-list samples: existing release 257 ms / 3 cards; candidate
  331 ms / 4 cards, including CO-SOA08838. These are single samples, not a latency
  benchmark.

Issues encountered and resolved: fixture SQL initially reused one parameter as
both bigint and numeric; corrected before behavioral RED. ESLint required
splitting the editability guard and reusing the source ID; all final runtime
checks were rerun afterward. A random test-date collision reused an edit lease
between repeated runs; each gauntlet subprocess now receives a fresh disposable
DB clone. Browser binaries were absent in the general test image, so the existing
browser image is used. A release rehearsal initially omitted a read-only fixture
mount; the mount was added and the rehearsal repeated. These failures are retained
in artifact logs. Unrelated pre-existing test assertions remain unchanged.

Reproduce from the repository root:

```sh
bash server/tools/co-direct-to-gauntlet.sh fresh
```

`finish` resumes static/reporting checks only for the same frozen runtime and
completed TAP logs. The baseline reversal patch is persisted; disposable databases
are used throughout. Tool versions: Node 20.20.2, fast-check 4.9.0, c8 12.0.0,
ESLint 10.8.0, TypeScript 7.0.2, Playwright 1.62.1, PostgreSQL 18. Exact test/browser
image IDs are recorded in `test-artifacts/co-direct-to/toolchain.json`.

- General test image: `sha256:0a5ee3f2197eb21d9959c4cd71d12917e7ce5e7b112c02845681ec9eea7c460c`
- Browser image: `sha256:07e28b566ad289128bd7443b604c3427c69e4c54cd6c2b36ecb016efceef510b`
- PostgreSQL image: `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`

Live release and correction completed on 2026-09-17 UTC:

- App image `mbbs-operator-app:co-direct-to-20260917-v1`, immutable ID
  `sha256:7a7d54b2a44867ee0a143ab331d3d494111a04913be698f2a18a69e208a92c38`.
- Scoped image diff: exactly the five runtime files below. Candidate startup and
  health checks passed. Worker, database and Ollama containers were unchanged.
- A guarded live rehearsal rolled back the entire business transaction before
  application. The repair rechecked the state fingerprint, then committed the
  pallet allocation, canonical CO quantities, and both plan projections together.
- TOB01102: 52.25 SQFT Trevista and 1 PALLET allocated to SOA08838. CO-SOA08838:
  six operational lines, five packed and unchanged, plus 6 unpacked PALLETs.
  The zero Trevista row retains its original requirement for reversal and is
  absent from operational detail and Dispatch cargo.
- Actual production Packed and Active list membership, CO detail, and load
  validation passed. Customer demand remains 52.25 SQFT Trevista and 7 PALLETs;
  pickup detail has one TOB01102 heading. Plan 328 revision 43 → 44;
  plan 329 revision 34 → 35. Source SO packing remains cleared.
- Private snapshots, repair evidence, release configuration and the previous
  image are retained under `/home/ubuntu/operatorapp-deploy-backups/co-direct-to-20260917`.
  Image rollback is prepared; a reverse live cutover was not exercised. No real
  loading/fulfillment was performed to test visibility.

Operational commands are persisted in `tools/co-direct-to-deploy.py` (`prepare`,
`apply`, `repair`, `verify`, `verify-repair`). The repair remains deliberately
scoped to these order and plan identities and checks exact preconditions.

Git base: `8640191ca7709a882c00bb684dfe24db10b03b2d`; unrelated existing working-tree
changes were preserved. The immutable deployed image records the full runtime;
only these five files differ from the prior deployed image.

| Runtime file | SHA-256 |
| --- | --- |
| `src/co-direct-to-cargo.js` | `1a1bd657bdea42862b07b30ac321f8ce723d2625d0e3f43366e6fb904bc34893` |
| `src/dispatch-local-co-cargo.js` | `a40badedddcfa7e7eda072705a6f6046faeb33cacaf45b592b887479dd862a56` |
| `src/dispatch-repository.js` | `8ab1a6509635be177cbb885f7e926cca06795b08a6e15dd914fe187899176c85` |
| `src/delivery-repository.js` | `ad9db60209b71631fc8ca5d0c35c3f18703c0d59458fdc1ce6fe4e95121a6b47` |
| `src/scm-dependency-command-service.js` | `2eceb9e5916221157ceed92eca369ced886a4f3a44091baf7e0a5e3646228ebb` |
