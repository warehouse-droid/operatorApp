# MBR Setup and sales PDF acceptance specification

Spec approval: not obtained (autonomous run). The user authorized implementation,
supplied the roster, and confirmed ATL1000. Model options contain model codes alone.
No dependencies, installs, commits, or unrelated changes are planned.

1. MBR Setup lists all 38 supplied units, 12 models, brands, descriptions, unit
   codes and exact trimmed VINs. Codes 10 and 13 remain unchanged. ATL1000 is used.
2. MBR Sales and Admin may read, add, edit, and deactivate equipment. Unauthenticated,
   unrelated-role, and customer-link users cannot access setup. Duplicate VINs or
   unit codes and malformed input are rejected. Stale edits cannot overwrite data.
3. New contracts offer model codes alone. SN is disabled until a model is selected,
   then contains only active matching VINs with unit codes as identifying labels.
   Changing model clears the old SN. Saving/reopening retains the selected pair.
4. Create, edit, and renewal reject unavailable/mismatched equipment pairs. Existing
   saved pairs (including older free-text values or deactivated units) can remain
   unchanged. Setup edits never rewrite contract snapshots or signed documents.
5. After saving, sales can download an unsigned PDF of the saved revision before
   signing, including expired contracts. It contains equipment, VIN, rates and all
   agreement clauses, clearly states unsigned status and has no electronic signature
   or protection-plan choice. Unsaved changes require saving before downloading.
6. Completed staff downloads return the original immutable signed PDF. Public PDF
   downloads continue to require completion. Customer signing and existing MBR
   permissions, link expiry, renewal and document behavior remain covered by the
   full MBR test suite. Shared navigation/server changes are merged onto the live
   image, retaining other deployed features.
7. The additive migration is transactional and can be rolled back in a disposable
   database; production rollback retains operational data. Candidate tests use
   standard isolated Compose, mbbs-tests.slice and bounded resources. Teardown is
   registered before startup, removes containers/volumes/networks on every exit,
   checks ps and ps -a and verifies production health. Logs/evidence are retained.

Tier 3 failure model: wrong model/VIN association (all-roster browser + HTTP tests),
lost edits (revision conflict/concurrent write tests), unauthorized setup (HTTP role
tests), setup changes corrupting historical contracts (legacy/deactivation/PDF
snapshot tests), false signed agreement (actual unsigned/signed PDF text checks),
partial migration/release (transaction rollback rehearsal, candidate validation,
live baseline hashes and release rollback), and host overload/orphan databases
(resource configuration checks and finally teardown).

Validation entry point: python3 server/tools/mbr-equipment-gauntlet.py all.

User follow-up: add an additional Download PDF button directly on every
mbr-contract-card. Downloads from the list use that card's saved contract and do
not navigate into the editor. Completed cards download the existing signed PDF;
pending/expired cards download the generated unsigned saved agreement.
