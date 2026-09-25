# Field Sales Trade pricing and MBR

Requested behavior: inline item autocomplete, MBBS TRADE-A, MBR/MBT TRADE,
three companies in one local quote with separate NetSuite estimates when enabled.

The catalog reads NetSuite SuiteQL independently of the transaction RESTlet.
Company membership, CAD currency, price level, sales unit and actual quantity
threshold travel with each suggestion. An online selection refreshes the item;
offline selections use cached data and are checked against the current catalog
when synced. Manually agreed rates do not require an item-level reason; an optional quote memo is available below the total. Historical quote snapshots
and PDFs retain their original prices and policies.

Administrators refresh the whole catalog in Settings. Refreshes stage all three
companies before replacing the catalog, serialize against individual price reads,
and retain the previous snapshot on failure. Subsidiary/currency mapping changes
while reading cause the refresh to fail without replacing data.

The read-only live probe verified subsidiary IDs MBBS 1, MBR 7, MBT 3 and CAD
currency 1; named price levels are TRADE-A 3 and TRADE 2. At the initial probe,
1,385 MBBS items included 1,265 priced items; 160 MBR items included 2 priced
items; 116 MBT items included 7 priced items. Missing Trade prices require an
agreed rate, or completion of the Trade price fields in NetSuite followed by a
catalog refresh. Quantity tier IDs must be resolved with BUILTIN.DF: for example,
the 1/2/3 IDs for item 692 mean thresholds 0/49/98. Three single-price items have
no resolved threshold and use a zero minimum.

Migration 211 extends company constraints, merges the MBR profile and clears old
Base Price/local MBT catalog suggestions. It does not alter immutable revisions
or queued financial payloads. Image rollback keeps the additive schema and data.

The updated RESTlet source accepts three distinct companies and explicit Trade
price requests. This release does not deploy that script to NetSuite or enable
financial posting. Forms, tax/status mappings and the dedicated RESTlet remain
required before quote publication is available.

Validation entry point: `bash server/tools/field-sales-trade-test.sh`.
Read-only live reader probe: `python3 server/tools/field-sales-trade-probe.py`.
Scoped release: `python3 server/tools/field-sales-trade-deploy.py prepare`, then
`build`, `bash server/tools/field-sales-trade-release-check.sh`, then `apply`.
All Docker commands require the normal host Docker permission.

Executable specification: [trade-spec.md](../test/field-sales/trade-spec.md).
Final checks, source hashes, browser screenshots, coverage and mutation results
are retained in `server/test-artifacts/field-sales/trade/`; release metadata and
the private database backup live in `trade-deployment-20260919/` next to it.
