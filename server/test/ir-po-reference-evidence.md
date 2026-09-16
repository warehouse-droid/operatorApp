# IR Memo and Ref No — verification evidence

Spec: [ir-po-reference-spec.md](ir-po-reference-spec.md). Spec approval was not
obtained separately (autonomous run under the user's implementation/deployment
instructions). Tier 3, scoped to one receipt payload field addition.

## Behavior and account evidence

The account's existing IR14634, internal ID 993562, has `SN1400333` in both
`memo` and `custbody9`. Its Created From remains PO 936958 / POB03658.
The live itemReceipt metadata labels `custbody9` **Ref No**, a nullable custom
string. Only GET and SuiteQL reads were used to identify the field.

New IR drafts now populate Memo and Ref No from the same normalized receiving
reference, before computing immutable hashes. Split and normal POs use their
stored receiving references; transfer IRs likewise mirror their existing memo.
IF behavior and receipt source/line/quantity selection are unchanged. Blank
references omit both fields. Existing receipts and stored commands are untouched.

## Spec mapping

| Acceptance criteria | Executed checks |
| --- | --- |
| Split and normal references reach both fields on the original parent | `ir-po-reference.test.js`, original nine SN1400333 tests |
| Actual REST payload serialization | `ir-po-reference-http.test.js`, real draft/adapter/transport with only HTTP boundary faked |
| Blank values, normalization, IF invariants | unit example matrix and 200 seeded property cases |
| Both hashes, grouping and conflicting references | immutable-hash and grouping tests; existing service/reconciliation suites |
| Arbitrary/hostile references and no field injection | seeded JSON round-trip property including quotes, newlines, script text and Unicode |
| Quantity, timing, retry and receiving regressions | 74-test focused suite plus full baseline/candidate comparison |
| Automatic camera and compact consolidation UI | 39 packaged unit/contract tests and 11 browser tests |

## Completed focused verification

- New behavior: all four new unit/property tests failed on the original source.
  A later original-source run also demonstrated all five new tests failing,
  including the real transport regression. The fix passed all five.
- Focused suite: **74 passed**, zero failures/skips. All 11 test files also
  passed separately in seeded shuffled order (seed 14634).
- Changed executable line coverage: **1/1**, executed 417 times in the final
  targeted coverage run. Changed branch details are validated in the results file.
- Four realistic faults (wrong field, parent reference substitution, omitted
  Memo, empty Ref No) were caught by both unit and property suites: **4/4 each**.
- Types: **233 pre-existing diagnostics, zero new**. Scoped IR lint: zero
  errors/warnings, including complexity rules. Secret scan passed.
- Camera static checks: no new diagnostics; the existing Operator JS baseline
  has 36 lint diagnostics. Browser tests use simulated media-device boundaries.
- Prepared release package: **50 passed**, zero failures, using files extracted
  from the candidate image. Six runtime files differ from the current app image;
  every packaged runtime/dependency-manifest hash matches the tested workspace.

## Full regression comparison

The final baseline completed all **492 files / 2,504 tests**: 2,502 passed,
one failed and one skipped. The candidate completed all **494 files / 2,509
tests**: **2,507 passed, one failed and one skipped**. All five new tests ran.
There are **zero new failures**. The identical existing failure is
`P3.12: browser specs share one worker-owned database-pool lifecycle`, concerning
the existing `dispatch-unpacked-split.spec.js` fixture import.

Mounting the repository's complete build files also resolved the test-harness
failure previously reported for the omit-dev runtime contract. No production
code or assertion for that contract changed; the corrected baseline and
candidate both pass it. The final gate therefore expects exactly the one
observed, named fixture failure, rather than the earlier historical count of two.

## Reproduction and limits

```sh
sudo -n bash tools/ir-po-reference-gauntlet.sh
sudo -n python3 tools/operator-camera-ir-reference-deploy.py prepare
sudo -n python3 tools/operator-camera-ir-reference-deploy.py apply
```

Preparation is intentionally single-use per release. The apply command refuses
stale source or regression evidence. The full-run comparison checks completion,
exact pre-existing failure names, test/file counts, coverage and source hashes.
Final full-suite totals are in `test-artifacts/ir-po-reference/verified-results.json`.
Node 20.20.2, TypeScript 7.0.2, ESLint 10.8.0, c8 12.0.0 and fast-check 4.9.0
were used. Source identity: `test/ir-po-reference-changes.json`, the camera
manifest and `test-artifacts/ir-po-reference/release-changes.json`.

No dependencies or migrations changed; dependency audit and migration rollback
are therefore not applicable. No new runtime network/filesystem capabilities
were added. Actual creation of a new NetSuite receipt was deliberately excluded
from verification, so remote acceptance of the new field on a future business
receipt remains to be observed. The existing live record and metadata confirm
the account field, and the offline transport test confirms the outgoing body.

The initial full baseline was invalid because its temporary source copy omitted
contracts/build files and used a path incompatible with the credential tests.
A subsequent harness attempt hit old artifact ownership and removed its baseline
copy during cleanup. Both invalid runs are excluded from final evidence. The
corrected harness mounts complete source at `/app`, uses consistent artifact
permissions, keeps baseline files until child runs finish, and preserves every
behavioral assertion. The original invalid logs are retained for audit.
