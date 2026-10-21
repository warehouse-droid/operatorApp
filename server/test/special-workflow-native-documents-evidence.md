# Native NetSuite PDFs, closure approval and Dispatch planning — evidence

Spec: [special-workflow-native-documents-spec.md](special-workflow-native-documents-spec.md).
Spec approval: not obtained (autonomous run). Tier 3. The user's requests authorize
this implementation and deployment; no live business order was closed for testing.

Deployed to the app and webhook worker on 2026-09-26. Image:
`sha256:91df9f618ae177e5ae3eaf89b8369a48b7d8e3c24b7b422dc2ba80061ce40022`. Both service configurations were preserved; database and
Ollama containers were unchanged. Migration 232 adds the closure review journal.
The previous application image is retained for rollback. The legacy local order
PDF renderer was removed from the image.

The user uploaded RESTlet 3.1.0. Live health advertises SO and PO PDFs, and both
native actions returned the exact linked orders: SOB121380 and POB03934 for
SPREQ-000007. The live cache check replaced all three permitted legacy previews
with original NetSuite bytes, fetched each once, and proved another service
instance returns the same saved bytes without a remote call. Sales PO access
returns 403 even with an SCM cache entry. Both PDFs render as one readable page
with the correct reference and reviewed item, quantity 50 PC. Local/public health
is 200; all five changed browser asset hashes match; anonymous PDF requests are
401. Business fields on SPREQ-000007 and the protected fingerprint of
SPREQ-000006 are unchanged. Neither order is currently Dispatch planned.

| Requirement | Executed verification |
| --- | --- |
| Native PDF identity, bytes and configured NetSuite form | `special-workflow-native-documents.test.js`, SuiteScript harness, live RESTlet/PDF checks |
| First-preview cache; relevant local changes; reject obsolete local template | Real PostgreSQL cache and authenticated HTTP tests, live saved-preview check |
| Sales SO only, SCM both, authorization on cached responses | Unit contracts, authenticated HTTP, four browser role/viewport scenarios |
| Bottom-right controls; quote available before SO | Browser at 1440px/390px for Sales and SCM, quote regression tests |
| Actual Dispatch SO/PO status, group/split and pickup aliases | Planning properties, real persisted-plan tests, browser cards/details |
| Sales request, SCM confirmation/rejection, execution guard | Real journal/service/HTTP tests; browser closure forms |
| Close PO then SO, exact lines only, verify both before local cancellation | Native adapter contracts and real service/database integration with only the NetSuite boundary mocked |
| Partial failure, lost response, duplicate reviewer, immutable recovery plan | Properties, journal retry tests, concurrent PostgreSQL advisory-lock tests |
| Block Dispatch planning while closure is pending | Full snapshot and V2 command tests, real case-row lock race |
| Safe additive migration | Upgrade from missing journal, repeat migration, constraint and transaction rollback rehearsal |

Final runtime verification: **236/236** Special Item/quote/related
Dispatch checks pass, **490/490** changed runtime lines covered,
**340/389** measured changed-line branches covered. All **6/6** manual
mutants are killed; the five invariant mutants are also killed when running only
the properties. The role-only mutant is attributed to the contract suite. The
54 focused checks pass again in reverse file order. Four real Chromium browser
role/viewport runs pass. Native PDF parsing passes strict JavaScript type checks;
all changed JavaScript passes syntax checking. Feature modules/tests/tooling pass
scoped ESLint; the large existing server file is covered by syntax, HTTP contracts
and changed-line coverage. The pre-existing SuiteScript `lookupError` catch name
is explicitly allowed by the scoped lint config. No runtime dependency changed.
The secret scan passes across 70 new paths plus the changed-line diff.

The broader Dispatch V2 suite passes 10/12 on both the deployed-source baseline
and current source in separate clean disposable database clones. The same two
failures, with matching assertion messages, are preserved:

- `history search reveals reconciliation-complete PO/SO orders but never Driver PWA-completed orders` — current Dispatch visibility assertion.
- `DP-11 and DP-12: targeted CO and atomic split commands return only affected records and exact retries` — one-order response includes the 609-order feed.

These are baseline failures, not newly introduced failures. The initial baseline
attempt reused a contaminated fixture database and was discarded; the final
comparison uses independently cloned clean databases. An early coverage attempt
omitted isolation environment variables and was also discarded. RED checks caught
unsupported native PDFs, preview alignment, an invalid local handoff status,
a missed V2 closure guard, Dispatch stop aliases and a large-base64 regex stack
overflow; all were corrected without weakening acceptance assertions. Initial
native PDF visual rendering needed the already-used standard-library PNG encoder
because Pillow is not installed; PDFium then rendered both documents successfully.

Reproduce the complete isolated gauntlet from the repository root:

```bash
bash server/tools/special-workflow-native-gauntlet.sh
```

This reuses the existing disposable `mbbs-special-review-runner` and
`mbbs-special-review-db` environment and browser test server. Tool versions:
Node v20.20.2, TypeScript 7.0.2, ESLint
10.8.0, c8 12.0.0, fast-check 4.9.0.
The source manifest, runtime diff against the captured deployed baseline, raw
logs, browser captures, mutation attribution and live metadata are saved under
`server/test-artifacts/special-workflow-review/native-documents/`.
Source manifest SHA-256: `e3bce497c4dba2eea6e825eb4f685b274631d23ab773ce1df24141d8e82759cd`.
No commit was made in the shared dirty workspace; source hashes identify this release.

Release and read-only live verification tools:

```bash
python3 server/tools/special-workflow-native-deploy.py verify
python3 server/tools/special-workflow-native-restlet-probe.py
sudo -n docker exec -i -w /app mbbs-operator-app-app-1 node --input-type=module - < server/tools/special-workflow-native-live.mjs
sudo -n docker exec -i -w /app mbbs-operator-app-app-1 node --input-type=module - < server/test-artifacts/special-workflow-review/native-documents/public-smoke.mjs
```

The live cache command writes only preview-cache entries for SPREQ-000007 and
private temporary copies of its PDFs. It imports no order writer. The first live
misses waited behind existing NetSuite background requests; repeated previews
were verified to avoid NetSuite entirely.

Limits: NetSuite REST cannot atomically lock both external orders against edits
by other NetSuite users. Complete pre/post verification and a durable pending
review detect conflicts and support recovery. Live closure writes were deliberately
not performed on real orders; closure behavior was exercised through real local
services/SQL with a simulated external NetSuite boundary. Cache invalidation tracks
relevant local order state; external-only PDF form changes do not automatically
refresh an unchanged local snapshot, consistent with the requested caching policy.
This release does not alter the existing legacy pair's native linkage or create a
replacement order.
