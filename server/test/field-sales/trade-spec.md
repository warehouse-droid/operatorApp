# Field Sales autocomplete and Trade pricing — 2026-09-19

Tier 3: prices, immutable quote revisions, company splits and schema changes.
Spec approval: not obtained (autonomous run). The user explicitly requested an
autocomplete textbox, MBBS TRADE-A prices, MBR/MBT TRADE prices, and MBR support.
Earlier deployment authorization remains in effect. No new dependencies or git
commits; use the retained isolated Node/Postgres/Playwright tool image and scoped
Docker image overlay. Leave NetSuite transaction posting disabled.

Acceptance criteria (append-only):

1. Add item is an inline, labelled autocomplete textbox on phone and desktop.
   Search SKU/description across all three companies or the selected company;
   keyboard arrows/Enter/Escape and pointer selection work. Debounce requests;
   late responses cannot replace a newer search or add the wrong item. Cached
   results work offline. Selecting an item fetches its current price online and
   stores the item, company, sales unit and price provenance in the draft.
2. Read active sale/resale items by verified NetSuite subsidiary membership.
   MBBS uses exactly TRADE-A, MBR and MBT exactly TRADE, in configured CAD currency.
   Never substitute Base Price, another currency, purchase-only items, discounts,
   or the old MBT local rate-card price. Missing tier requires an agreed rate and
   reason. Failed refresh retains the prior complete catalog; concurrent refresh
   and per-item refresh serialize so an older snapshot cannot overwrite a newer
   one. Incomplete configuration fails before deactivating any catalog item.
3. Quantity selection uses the actual NetSuite threshold, not its internal index:
   live account evidence: item 692, pricing.quantity IDs 1/2/3 resolve through
   BUILTIN.DF to thresholds 0/49/98. Choose the largest threshold <= quantity;
   reject invalid/negative/ambiguous prices. Decimal comparisons are exact.
   Changing quantity updates an unmodified suggested price; preserves a manual
   override. Server save checks the correct quantity tier and snapshots provenance.
4. One quote may contain all three companies; independently rounded company taxes
   and combined totals/PDFs remain exact. MBR creates its own stable estimate link;
   revisions reuse it, removal closes it, existing recovery gates still apply.
   RESTlet source accepts three distinct company estimates and uses explicit Trade
   price policy. Existing historical revisions/PDFs remain unchanged.
5. Additive migration permits MBR in all three company constraints, merges its
   settings without resetting existing policies, and invalidates legacy catalog
   rate suggestions (not historical quotes). Rehearse rollback in a transaction.
6. Existing route, visit, map, permissions, offline queue, conflict and posting
   recovery tests remain green. No actual financial transactions during testing
   or deployment; remote RESTlet deployment remains separately gated.

Failure model and checks:

- Wrong tier/currency/company/unit, quantity index mistaken for threshold: network
  boundary contract tests, exact-decimal properties, explicit live read-only probe.
- Missing prices defaulting to zero/base: server validation and browser required
  agreed-price path; mutants replacing policy/threshold/null handling.
- Stale autocomplete or double selection: browser delayed-response/keyboard tests.
- Partial catalog replacement or stale concurrent refresh: transactional DB tests.
- MBR dropped from totals/splits or lost on revision: three-company lifecycle,
  independent rational oracle, immutable PDF and existing lost-response tests.
- Migration loss/failed release: transaction rollback rehearsal, retained DB backup,
  exact-image smoke and scoped release with prior-image rollback.

Intentional existing contract revisions before implementation: catalog P1/P2
previously assert MBBS mirror/base prices and MBT local rate cards; replace those
assertions with the requested NetSuite Trade policies. RESTlet NS3 previously
asserts base price and must instead assert explicit Trade. Browser selectors for
the old Add item modal are replaced with equivalent autocomplete interactions;
retain their existing quote-total, PDF and offline/conflict assertions.

Gauntlet: full Field Sales suite, strict types for shared pricing/money, scoped
lint, coverage, 3–5 manual mutants plus property-only mutation run, randomized
suite order, desktop/phone browser execution and hostile input checks. Record
uncovered lines and skipped wider-repository layers honestly in evidence.

2026-09-19 live-data refinement before release: three active items (Pallet,
Bin 14YD, Bin 20YD) have a Trade price with a null quantity threshold. Treat an
absent quantity tier as the single starting tier (zero minimum), while rejecting
malformed nonempty thresholds. Add a reader regression fixture for this case.
No rounding or Base Price fallback is introduced.

Upgrade refinement: cached catalog entries from the previous release carry a
source label but no Trade price-level metadata. Such legacy suggestions must be
blank in the autocomplete and when selected offline. Existing historical quote
snapshots remain unchanged; syncing an old draft still requires the current
price or an agreed-rate reason. Empty metadata on manually seeded test fixtures
retains the existing fixture contract and is not produced by the live reader.

Coverage clarification: retain the repository's existing 95% line/function and
90% branch thresholds for the original Field Sales server scope plus the new
shared pricing code. The newly collected browser coverage is a separate report:
applying server-wide thresholds to unchanged quote customer/reconciliation UI
would be a new unrelated requirement. Measure changed quote/autocomplete lines
from the original saved files and require their execution. The diagnostic exposed
an untested explicit price-refresh action; add a behavioral browser check that
applying Trade resets the rate/reason, then an agreed rate survives quantity edits.
Also verify MBR settings save and error cases for configuration changes, empty
catalogs, disappeared items, ambiguous prices and wrong currency labels.

Late price-response refinement: when a rep leaves the editor or opens another
quote while an item/price refresh is pending, the response must not add a line to
another draft or reopen the old screen. Bind the response and redraw to the
original draft and connected editor. A browser test holds the price response,
opens a new quote, then releases it and asserts the new quote stays empty.
