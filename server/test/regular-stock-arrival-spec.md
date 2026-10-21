# Arrival fields only for Delivery

Spec approval: not obtained (autonomous run). Implementation and deployment after
passing checks are authorized by the user. Tier 3, because arrival validation
participates in stock approval and the server request contract.

Acceptance criteria:
- Pickup and Stocking show no arrival date/time inputs, and submit successfully
  with both omitted. A stale, invalid or partial date from an older client is
  ignored and persisted as null for these methods, never a fabricated date.
- Delivery shows both mandatory inputs, normalizes valid Toronto date/time, and
  rejects missing, impossible or ambiguous arrival values. Its configured lead
  time continues to control automatic approval.
- Changing the method updates the form immediately, retaining other entered
  details. A previous invalid Delivery date cannot block Pickup or Stocking.
- Editing to Pickup/Stocking removes stored arrival details; editing back to
  Delivery requires valid values. Date-free Pickup supports manual decisions,
  SO handoff and expiry/re-raise; date-free Stocking supports direct SCM TOs.
- Safety, the auto-approval switch, Stocking manual review, approval expiry,
  duplicate prevention, and custom confirmation remain in place.
- New no-date request summaries omit the arrival card. Historical saved dates
  and completed approval snapshots remain readable and are not rewritten.
- English and Chinese manuals describe Delivery-only date/time and use current
  screenshots. Special-request behavior is unchanged.

Failure model and checks:
- UI/backend disagreement or stale hidden invalid values: real browser method
  switching/submission, invalid legacy input, and SQL service tests.
- Accidental Delivery lead-time bypass or invalid time accepted: example and
  generated domain/normalizer tests; manual mutants.
- Date-free requests break later lifecycle: SQL re-raise, approval, SO and direct
  TO tests with omitted dates; browser confirmation and retry regression.
- Asynchronous blur validation after method change: method guards and browser
  invalid-date switching; no new external operations.
- Deployment includes unrelated work: task-only before snapshots, source hashes,
  scoped image overlay, whole-image tree comparison, existing rollback path.

Setup: reuse installed Node/Playwright/PostgreSQL test images, isolated internal
Docker network and disposable DB. No dependencies, migrations or commits. Add
task-specific tools, test artifacts and deployment evidence, preserving earlier
release evidence and unrelated workspace changes. Test NetSuite transport only
with stubs; production verification is read-only. Full relevant regression,
static checks, changed-line coverage, generated properties, manual mutations,
shuffled suite order and browser execution precede scoped deployment.

## Scope addition: special quote packing columns

The user added: show PLT, LYR, SEC and PCS in special-order quote previews like
the existing NetSuite quote. `/home/ubuntu/QuoteSample.pdf` is the local reference:
dedicated columns after Amount, ordered PLT, SEC, LYR, PCS.

- Draft and saved special quotes display each material's entered packing counts
  in these four columns, preserving zero, fractions and missing legacy values.
- Saved ancillary lines retain any recorded packing counts. Do not infer packs
  from the sales quantity or UOM; sales quantity/rate/discount/tax stay unchanged.
- Customer-facing documents must not expose SCM costs or internal notes. Existing
  Field Sales quotes keep their existing layout; SO/PO PDFs remain native.
- Multi-page quotes repeat the packing headings and show the final item. Render
  a realistic sample and inspect column alignment, Chinese text and large values.
- Cover draft/saved mapping, generated quantities, unchanged totals, actual PDF
  text/pagination, authenticated quote preview and adjacent Field Sales PDFs.
  Extend scoped deployment by only the special quote mapper and shared renderer.

Test-contract update: the existing HTTP test for mandatory arrival normalization
now uses Delivery instead of Pickup, preserving its normalization/revision
assertions under the new requirement. The new date-free lifecycle tests cover
Pickup. The generated packing test compares field values independently of a
generator-created null object prototype; prototype identity is not quote data.
