# Pack columns and pickup yard scope — deployed 2026-10-10

PLT/LYR/SEC/PCS now carry the operator's current physical counts into selected
IF/IR lines, including explicit zeros. These descriptive fields do not gate
verification. The existing strictly-below-0.01 SQFT rule is unchanged.

Customer pickup lookup, detail refresh, confirmations, draft clearing, posting
preflight, and finalization use the selected parent yard. Inventory child
locations remain unchanged. Loading preserves the other yard's draft and
computes completion across the whole SO. The load-screen summary includes only
the selected yard. Ordinary delivery authorization remains unchanged.

Spec approval: not obtained (autonomous run). Tier 3 inventory and authorization
work; confidence is bounded by the self-authored specification and tests.

## Live outcome

- SOA10099 (1053286): 3445 returns only line 531490; 2967 returns only line 531491.
  Both scopes resolve the matching canonical posting yard and one confirmation
  line, including for an account assigned only that yard.
- SOA10124: existing IF157565 (1053555) reads 31.38 SQFT and 3 LYR. The existing
  descriptive correction was already present before deployment; this task made
  no direct NetSuite record repair or new inventory transaction.
- Application image: `sha256:91d91242c0c571abffbacd120d1faa896419b95d2e2db4de6fa0d13e1b1d3d0f`. Only the app was replaced;
  configuration, DB, webhook worker and Ollama were preserved. Local/public
  health returned 200 and all three served pickup assets matched the candidate.
- Read-only live verification: 2026-10-10T19:51:36.216Z.

## Acceptance evidence

| Criteria | Executable evidence |
| --- | --- |
| E1/E2 actual pack counts, SO/TO IF and PO/TO IR, deltas, kit boundaries | unit/operator-posting-pack-quantities.test.js |
| E3 grouped counts and immutable evidence | same unit suite, grouped-count property and durable lifecycle |
| E4 SQFT rounding and genuine 3-vs-7 partial shipment | pack-column and existing rounding suites |
| E5 descriptive mismatches do not block; accounting mismatches still hold | pack-column unit properties and integration lifecycle/recovery |
| E6 invalid optional integer metadata never gates quantity | pack-column adversarial cases and generated target mappings |
| E7 completion and replay happen once | integration/operator-posting-pack-quantities.test.js |
| E8 source isolation, rollback, configuration and cleanup | release manifest, deployed.json and final Docker logs |
| E9 per-yard lookup, child locations, grants and fail-closed guards | customer-pickup-yard-scope unit/integration suites and yard-access regressions |
| E10 foreign confirmations blocked; other draft preserved | mixed-yard HTTP/repository integration tests |
| E11 scoped preflight, canonical finalizer, later second-yard pickup | mixed-yard target properties and gated/DB lifecycle tests |
| E12 refreshed detail and summary, mutations, cache version | customer-pickup-yard-ui runtime contract tests and HTTP detail tests |

RED evidence is retained in red.log, adversarial-red.log, lifecycle-red.log,
yard-red.log, preflight-red.log, child-legacy-red.log and load-refresh-red.log.
Pre-existing nonblocking/tolerance behavior and scope guard regression armor
were challenged with deliberate mutants.

## Verification layers

- Original live baseline: 569 tests in 69 files passed.
- Final affected component: 621 tests passed against the exact candidate.
  Runtime source hashes were unchanged when those regressions were reused;
  subsequent focused checks covered three additional error/fallback cases.
- Final shuffled component: **624/624 tests in 74 files passed**.
  Focused coverage/lifecycle/UI checks also passed 55/55.
- Changed executable lines: **219/219 covered**.
  Frontend checks execute extracted original functions in a VM; whole-browser
  end-to-end interaction was not rerun. HTML cache wiring is tested separately.
- Mutation: **26/26 runs killed**, covering 18 distinct
  pack, quantity-gate, yard, draft-preservation, finalizer and refresh faults.
  Pack/yard properties independently killed their relevant mutants.
- Types: baseline 866 diagnostics, final 866, zero
  new diagnostics. Existing source lint findings remain at baseline; zero new
  findings. New modules, tests, tools and operational verification passed strict
  lint. Syntax and scoped secret scanning passed.
- No new dependencies, schema changes, or checkpoint commits. All tests used the
  standard isolated resource-bounded Compose runner in mbbs-tests.slice with
  registered teardown. Test DBs, containers and networks were removed; both
  docker ps and docker ps -a contain only the four production containers.
  Production/rollback volumes and audit records were retained.

The real NetSuite boundary was read for metadata and the existing IF; new posting
and recovery behavior were exercised with a stubbed NetSuite boundary plus the
real HTTP, DB, durable command, and finalization code. Full unrelated repository
suites were skipped because the complete affected component was exercised.

Evidence directory: `server/test-artifacts/operator-posting-pack-quantities/`.
Candidate and rollback: `/home/ubuntu/operatorapp-deploy-backups/operator-pack-quantities-20261010`. Private deployment snapshots
contain configuration and must remain private. The scoped release.patch overlays
12 files on the captured live image; unrelated workspace edits are excluded.
