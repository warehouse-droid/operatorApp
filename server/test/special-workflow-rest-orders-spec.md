# Special order REST writes, 2026-09-26

Spec approval: not obtained (autonomous run). The user explicitly requested REST
API order writes, an actual negative percentage discount (never an amount
substitute), Custom pricing, and authorized SOB121380 for testing. SPREQ-000006
is excluded from all mutations.

Use the existing Tier 3 old-coder workflow and installed test tools. No new
dependencies, repository reset, or commits. Keep unrelated workspace changes.
Persist isolated test evidence and scope any release to changed runtime files.

Failure model and acceptance criteria:

1. A numeric rate can be a currency discount even when it looks like a percent.
   Test the account on SOB121380 using Custom pricing, save its complete baseline,
   and verify transactionline.ratepercent, adjacency, original line identities,
   native links, and the unchanged total 1457.70. Restore after the capability
   probe. Never deploy a currency substitute or report an unverified percent.
2. REST can reject a literal percentage before saving. Preserve the exact error,
   verify the order did not change, and do not retry that payload automatically.
3. Special SO/PO creation and adjustments must use the REST Record transport;
   the PDF RESTlet remains available for previews. No write path may depend on
   an uploaded RESTlet capability or fall back to RESTlet mutation.
4. Preserve approved commercial values, SCM review, native order/line links,
   unexecuted-order guards, Dispatch guards, unrelated lines, and PO costs.
   Test snapshots against stale/partial state and retry after a lost response.
5. Never duplicate the uncertain SPREQ-000009 order. Check both marker and
   external ID before a narrowly journaled retry; use the marker as the unique
   external ID for REST creation. Existing uncertain submissions do not become
   generally retryable just because one case was checked.
6. Retain PDF access controls, cache invalidation and existing Sales/SCM UI.
   This change does not require new UI or an uploaded RESTlet script.

Live capability findings (append-only):

- Literal `rate: "-15%"`, `price: {id: "-1"}` on SOB121380 was rejected by
  REST with HTTP 400 INVALID_VALUE: `Unable to parse value '-15%' (String)
  from the Number field (rate).` All saved order values and SPREQ-000006 were
  verified unchanged. The numeric negative-rate probe will distinguish a native
  percentage from an amount; its outcome determines the supported implementation.

- Numeric `rate: -15` with Custom price was accepted, but saved discount amount
  was -15, with no transactionline.ratepercent. The discount was appended after
  PALLET despite its position in the input array. The saved total was 1610.25,
  rather than the required 1457.70. The probe restored the exact original lines,
  prices, quantities, total and identities. A subsequent independent read also
  verified original local case/order lines, review and attention state, SO total
  1457.70, PO total -282.50 (SuiteQL sign convention), pending statuses and the
  protected SPREQ-000006 fingerprint. The user reiterated that the discount must
  immediately follow the MBBS-Special material, never PALLET.
- Neither tested payload meets the required percentage and position. Do not
  enable either as a production fallback or retry SPREQ-000009 with them. No
  application runtime or deployment was changed during this capability test.

## User-approved requirement change: calculated amount

The user now explicitly permits a numeric currency discount: 15% of 100 is -15;
15% of 200 is -30. This supersedes the literal-percent requirement in criterion 1
and the earlier decision to prohibit an amount substitute. Preserve the selected
percentage in the local review, calculate each discount from its material amount,
round currency correctly, and recalculate when quantity or percentage changes.
Each Custom Discount% line must immediately follow its MBBS-Special material.
PALLET and vendor costs remain outside the discount calculation. All order writes
must use REST, and retries must preserve existing native material/PO links.

Before implementation, test whether a REST replacement listing all existing
line keys can reorder an appended discount. The bounded test uses -150 against
SOB121380's gross material amount 1000, maintains total 1457.70, and restores the
original order afterward. Do not recreate linked material lines to fix ordering.

The keyed reorder probe preserved the old order even when every key was supplied
in the desired order. For insertion before PALLET, the saved plan may recreate
only the unlinked PALLET (same quantity, rate, tax code, UOM and description), and
the local completion transaction must deactivate its old canonical row and bind
the verified new key. Material and native PO keys remain intact. Insertion before
a later material is rejected before any write; REST does not offer a verified
in-place insertion for this case. Existing adjacent discounts can be changed or
removed without this limitation, and new SOs get the correct complete line order.

Tests that required literal percent payloads now require calculated amounts,
per the user's explicit revision. The uploaded RESTlet's legacy protocol tests
remain with explicit legacy fixtures; production transport tests now exercise
REST and forbid an order RESTlet call. No PDF script upload is required.
