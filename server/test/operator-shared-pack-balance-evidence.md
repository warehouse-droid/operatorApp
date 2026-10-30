# Operator shared packing balance

Customer Pick-Up and Delivery Prep now use the item's PLT/LYR/SEC/PCS conversion
factors against one remaining sales quantity. Original order packing remains
unchanged. Input limits account for the other currently entered units; saves cap
the combined converted total. Group allocation also respects each source line's
balance. Authorized re-load packing uses its remaining authorized total.

The selected item's extra Total, Loaded, Confirmed and Remaining summary is
hidden at the user's request. The usual quantity fields and packing controls
remain visible; the shared conversion limits still apply.
Default packing retains the original combination where it fits; after breaking
a pallet, the remaining loose quantity can exceed the original loose quantity.
Items without conversions retain their existing sales/manual quantity behavior.

Verified with synthetic data through the real application and PostgreSQL in the
repository's disposable Compose environment:

| Stage, 1 PLT = 20 PCS | Total PCS | Loaded PCS | Confirmed PCS | Remaining PCS |
| --- | ---: | ---: | ---: | ---: |
| Ordered 1 PLT + 5 PCS | 25 | 0 | 0 | 25 |
| Confirm 10 PCS | 25 | 0 | 10 | 15 |
| First pickup recorded | 25 | 10 | 0 | 15 |
| Confirm the remaining 15 PCS | 25 | 10 | 15 | 0 |
| Second pickup recorded | 25 | 25 | 0 | 0 |

- Six Chromium scenarios passed: the complete partial-pickup sequence for PCS,
  LYR and SEC, and Delivery Prep edits for each unit. They verify page confirmation,
  reload persistence, maximum input limits, load-review quantities, completion text,
  and a phone-width display. Confirmation and load requests use the real API;
  synthetic photo evidence is supplied to the load endpoint. The browser fixture
  suppresses the unrelated global notification stream.
- 101 unit/integration regression tests passed, covering shared balances, combined
  limits, original order preservation, SO/TO partial loading, grouped allocation,
  SQFT rounding, sales-only items, existing pickup behavior, local VRMA and CO handoff.
- The existing Sales Order re-load harness passed its 6,480 quantity properties.
- ESLint passed for the three new test files; JavaScript syntax checks and
  `git diff --check` passed.

New tests: `mbt/unit/operator-shared-pack-balance.test.js`,
`mbt/integration/operator-shared-pack-balance.test.js`, and
`mbt/integration/operator-shared-pack-balance-browser.test.js`.

Run them from the repository root with
`bash docker/run-dispatch-source-tests.sh node --test --test-concurrency=1 test/mbt/unit/operator-shared-pack-balance.test.js test/mbt/integration/operator-shared-pack-balance.test.js test/mbt/integration/operator-shared-pack-balance-browser.test.js`.

All runs used the standard limits and `mbbs-tests.slice`, with teardown registered
before startup and unique retention-runner artifact directories. Each run removed
its containers, disposable database storage, network and generated artifacts.
Both `docker ps` and `docker ps -a` showed only the four production containers
after teardown; production health passed.

Deployed on 2026-10-23 at 15:58 UTC as
`mbbs-operator-app:operator-shared-pack-balance-20261023`. The release overlays
six files on the previous live image and includes the Operator cache version
update. Its exact candidate passed 21 tests, including all six browser scenarios
and the asset checks, plus the 6,480-property re-load harness. The built image
matched all 1,477 candidate runtime files and passed its import check.

The application restarted after active operations finished. Runtime configuration
was preserved; the database, worker and Ollama containers were unchanged. Local
and public health checks passed, all three updated public assets matched their
expected hashes, and both checked APIs continued to reject anonymous access.
The previous image and the release audit are retained in
`server/deployments/operator-shared-pack-balance-20261023` for rollback.

On 2026-10-23 at 18:17 UTC, deployed
`mbbs-operator-app:operator-hide-pack-balance-20261023` to hide the extra summary.
The 21 release tests passed again; browser checks now verify that the summary is
hidden while normal quantities remain visible, including the phone layout.
Only CSS and its page/service-worker cache versions changed. Both local and
public health and asset checks passed, with runtime configuration and dependency
containers preserved. Disposable test resources were removed after verification.
