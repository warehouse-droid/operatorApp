# SOB121380 separate discount conversion

Spec approval: not obtained (autonomous operational run). The user requested the
separate discount line on this existing SO and uploaded RESTlet 3.2.0 after the
exact conversion was explained. No new commercial discount is being selected.

1. Only SPREQ-000007 (62), SO SOB121380 (1017068), may be converted. Its existing
   material key 5028178 has 50 PC at 17, an original rate of 20, and a saved 15%
   discount. Convert it to 50 PC at 20 followed by item 10716 at -15%. Material
   subtotal remains 850. Preserve the actual complete SO total, header, tax code,
   quantities, descriptions, native links and the existing material identity.
2. PALLET key 5028179 remains 11 EACH at 40. PO POB03934 (1017168) remains exactly
   unchanged, including 50 PC at cost 5. SPREQ-000006 remains untouched.
3. Verify the uploaded script and active discount item, all original values,
   pending/unexecuted status, absence of Dispatch planning and absence of another
   pending review before any write. A stale or unexpected state fails closed.
4. Use the existing tested adjustment adapter and review service. Persist the
   complete plan in the existing review journal before remote writes, with an
   explicit system audit entry referring to this user-requested representation
   correction. Do not impersonate the prior SCM reviewer. The old review is
   preserved in the private checkpoint and referenced by ID in the new review.
5. Retry the same saved plan after partial failure; never create another SO, PO,
   material line or discount line. Verify both complete records and the unchanged
   SO total after applying. Update local native discount metadata through the
   existing review completion path. Fetch the actual SO preview through the
   application's cache service after the local snapshot changes.

Failure model: double discount, PO repricing and tax/total drift are checked by
exact pre/post comparisons; races and partial saves use the existing case lock,
durable plan and validated NetSuite adapter; wrong-case writes are blocked by
fixed identities and a protected-case fingerprint. A save followed by a failed
verification remains recoverable in the existing attention journal.

Setup: no application source, schema, dependency, deployment or git change. Add
one bounded operational script and evidence. Reuse the previously verified
254-test adjustment implementation and execute the relevant adapter/RESTlet
tests before live use. No production writes are used as tests; the live write
is the user's requested correction. Private checkpoints and PDF evidence use
mode 0600 files. Existing dirty work is preserved.

Live preflight finding: RESTlet 3.2.0 rejected the pending pair because it treated
`getText(orderstatus)` as an English status label. Both live transaction codes
are B; the SO is Pending Fulfillment and PO is Pending Receipt. NetSuite's
SuiteScript record browser describes PO orderstatus as text, not a select.
The correction must read the native orderstatus value, permit only A/B, and
continue rejecting executed, closed, unknown or missing statuses before saving.
The human-readable label must not override a non-pending code. Add an explicit
property over native codes and arbitrary labels, and verify the line-level
execution guards still reject fulfilled, received, billed and closed lines.
Advance the upload artifact to 3.2.1. This is the only runtime source change;
no app restart or permission change is required. The SO conversion remains
pending until the corrected script is uploaded.
