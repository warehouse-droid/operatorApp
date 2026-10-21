# Customer signing section and defaults

Spec approval: not obtained before implementation (autonomous run). The user
explicitly requested the signing section second, rental protection accepted by
default, and consent checked by default. Existing deployment authorization and
the established MBR release workflow continue. No dependencies, installs, commits,
database migration, staff form changes or agreement text changes are planned.

1. A pending customer's direct top-level sections are contract details, signing,
   then the complete rental agreement. All 14 agreement headings remain present.
2. Accept the Rental Protection Plan starts selected, Decline starts unselected,
   and consent starts checked on a new visit or reload.
3. Customers can choose Decline. The submitted and stored choice and signed PDF
   reflect the actual radio selection, including an explicit decline.
4. Customers can untick consent. Unticked consent blocks signing, and the API
   continues rejecting false/missing consent. Defaults do not submit anything.
5. Signing still requires signer name, a drawn signature, the current revision,
   a valid signing link and a deliberate Sign agreement action. Existing signed
   terms and PDFs remain immutable; completed pages show no signing form.
6. A stale-revision refresh shows current terms, resets protection/consent to the
   requested defaults and clears the old signature. A new signature is required.
   This deliberately replaces the old browser assertions expecting empty choices
   and unchecked consent after refresh; those assertions are updated before code.
7. On desktop Chrome and phone Chrome/Safari the order, defaults and editable
   choices work, the agreement remains visible, and no horizontal overflow or
   accessibility violations are introduced.

Tier 3 failure model: a default is visually selected but submitted differently
(real signing + stored snapshot + PDF checks); unchecked consent/blank signatures
accidentally submit (browser request counts plus existing HTTP rejection tests);
stale signatures survive re-render (fresh-signature browser assertion); agreement
content disappears or mobile order differs (DOM/order/all-heading browser checks);
release overwrites concurrent changes (narrow source merge, hashes, unchanged
configuration and rollback). The complete MBR backend suite remains in scope.

Validation: new browser assertions run RED against the original code, then the
full MBR backend suite, existing signing browser suite, strict shared types,
targeted lint, focused browser mutations and changed frontend line coverage.
Existing money properties run unchanged; no new parser/math properties apply to
this layout/default change. Unchanged equipment/rate browser suites are not
repeated; they passed for the preceding release and these files do not affect them.
All test workloads use the standard bounded isolated Compose project and
mbbs-tests.slice. Teardown is registered before startup and removes containers,
disposable database storage and networks on every exit; verify ps/ps -a and health.
Keep logs in test-artifacts/mbr-signing-defaults; use the existing pinned toolchain.
