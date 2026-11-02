# Damage stock photo names and compressed download — evidence

Request (2026-11-02): name downloaded Damage photos
`Brand_location_month_Damage_SKU_photo-NN` (e.g.
`BVS_3445_Oct_Damage_BVS-DMD-2430_photo-01`) and let the user choose original
or compressed photos. Spec: `damage-photos-spec.md` Z2 and Z6.

- Brand is the SKU prefix before the first hyphen (`Other` when absent);
  location is the yard name; month is the short English month; NN continues
  per SKU across transfer lines and saved reports. Names stay unique even when
  they differ only by letter case.
- Compressed is done in the browser: JPEG, longest side 1600 px, quality 0.8.
  Photos that cannot be decoded or would not shrink keep their original bytes.
  The original download is byte-identical to storage.
- Validation (`tools/damage-photo-names-release.py validate`, live src +
  candidate public, isolated bounded stack): live code fails the new naming
  tests; candidate passes 62/62 across 12 files, including a Chromium test that
  checks 1600 px JPEG output and byte-identical originals. All 7 mutants in
  `tools/damage-photos-mutations.mjs` killed. Teardown verified.
- Fixed `damage-photos-browser.test.js`: its init script re-seeded the token
  on `/login.html`, so the expired-session test could never pass.
- Deployed 2026-11-02T20:23:59Z as
  `mbbs-operator-app:damage-photo-names-20261102` (static files only, no
  migration); live hashes, health and HTTP checks verified. Rollback image
  `mbbs-operator-app:damage-photo-names-rollback-20261102`.
