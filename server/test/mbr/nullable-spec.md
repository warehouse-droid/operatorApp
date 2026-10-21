# Optional MBR contract fields

Spec approval: not obtained (autonomous run). The user explicitly requested that
all contract form fields may be null and confirmed that Setup records are excluded.
Continue the existing evidence-first validation workflow; no dependencies, commits,
equipment seed changes or database migration are needed.

1. Text, dates, model/SN, daily/weekly/monthly rates, deposit and signing-link expiry
   accept omitted, null, empty and whitespace-only form values, stored as null.
   Entered values retain the existing size, calendar, money and duration validation.
   Rental-date order is checked only when both dates are entered.
2. Every contract form control is optional. Clearing rates/deposit keeps them blank
   when saved/reopened; it never turns a missing amount into zero. The model/SN
   dependency remains: SN choices follow the selected model; a chosen model may
   have no SN, and an entered SN must match its model. Historical selections survive.
3. An entirely empty contract can be saved, reopened, edited, renewed, listed and
   downloaded as PDF. Empty terms remain original blank lines in the agreement,
   with no literal null/undefined, invented dates, amounts or customer names.
4. Null expiry uses three days when issuing/restarting/renewing a signing link,
   while the stored optional field stays null. An entered positive duration is used.
5. Setup fields remain required; customer consent, protection choice, signature,
   signer name, staff authorization, revisions and signed-PDF immutability remain
   enforced. Existing MBR and model/SN regression tests remain in the final suite.
6. Release only these changes over the current live image, preserving concurrent
   deployed features and operational data. Use standard isolated Compose with
   mbbs-tests.slice, bounded resources and registered teardown; remove every test
   container/volume/network and verify ps/ps -a and live health at every exit.

Failure model: null values silently become zero or text (normalization/property,
actual agreement/PDF and browser tests); half-filled dates or model/SN lose validity
(partial-input and matching tests); null expiry breaks links (HTTP issue/edit/renew);
optional form fields accidentally weaken signing/Setup (existing strict regressions);
partial release overwrites another change (live three-way merge, candidate hashes,
configuration checks and rollback). Tier 3 constraints cover contract integrity.

Reproduce: python3 server/tools/mbr-nullable-gauntlet.py candidate.
