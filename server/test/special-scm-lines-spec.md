# Special Order SCM line layout and required dates

Authorization: user requested these changes. Spec approval: not obtained (autonomous run).

- SCM material description uses the normal body font and wraps long text safely.
- Desktop SCM quantity, Sales UOM, PLT, LYR, SEC and PCS share one row; phone controls wrap with no page overflow.
- Sales retains editable required dates in its case editor and order adjustment.
- SCM can save required-date corrections in a pre-order stock check, and both audiences see the persisted date.
- Invalid or past date changes reject the complete SCM batch without partial writes. Unchanged legacy dates remain compatible.
- New request lines default to 14 calendar days after today in the existing Toronto business timezone, including month/year boundaries. Manually edited dates survive adding lines and refreshes.
- Existing rate, discount, note and order locks remain in force; conversion controls stay removed.

Setup: use the existing isolated Node/Chromium/PostgreSQL runner. No dependencies, migrations, git staging or commits. Release only scoped app files over the captured live image, with configuration checks and rollback.

Failure model: date ignored (HTTP persistence test); partial batch save (rollback snapshot); past/invalid date (adversarial validation); timezone or rollover error (clock and property checks); packing unreadable (desktop/mobile browser checks); unrelated Sales layout or financial fields (existing regression suite); unexpected live drift (guarded release capture and exact source hashes).
