import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY,
  smartScmNormalizePalletQuantityOverrides,
  smartScmPalletQuantityOverridePatch,
  smartScmPhysicalPalletLines
} from "./smart-scm-planning-repository.js";

assert.deepEqual(smartScmPalletQuantityOverridePatch({ quantity: 0 }), { reset: false, quantity: 0 });
assert.deepEqual(smartScmPalletQuantityOverridePatch({ quantity: "0" }), { reset: false, quantity: 0 });
assert.deepEqual(smartScmPalletQuantityOverridePatch({ reset: true }), { reset: true, quantity: null });
for (const invalid of [
  {},
  { quantity: null },
  { quantity: undefined },
  { quantity: "" },
  { quantity: "  " },
  { quantity: -0.01 },
  { quantity: 1e308 },
  { quantity: SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY + 0.01 }
]) {
  assert.throws(
    () => smartScmPalletQuantityOverridePatch(invalid),
    /PALLET quantity must be a non-negative number/,
    `Expected ${JSON.stringify(invalid)} to be rejected.`
  );
}

assert.deepEqual(
  smartScmNormalizePalletQuantityOverrides({
    15: null,
    26: "",
    28: " ",
    1: undefined,
    2: 0,
    3: "0",
    4: 1.25,
    5: 1e308,
    6: SMART_SCM_MAX_PALLET_OVERRIDE_QUANTITY + 1
  }),
  { 2: 0, 3: 0, 4: 1.25 },
  "Only deliberate, finite, in-range PALLET quantities may survive normalization."
);

const proposal = {
  id: 901,
  lines: [
    {
      itemId: 101,
      itemName: "Material A",
      destinationLocationId: 15,
      destinationName: "12441",
      proposedPallets: 3
    },
    {
      itemId: 102,
      itemName: "Material B",
      destinationLocationId: 26,
      destinationName: "150",
      proposedPallets: 2
    }
  ]
};
const palletItem = { itemId: 699, itemName: "PALLET", unit: "EACH", itemWeightLbs: 40 };
const automatic = smartScmPhysicalPalletLines(proposal, palletItem);
assert.deepEqual(
  automatic.map((line) => [
    line.destinationLocationId,
    line.automaticQuantity,
    line.quantity,
    line.overrideQuantity,
    line.overridden,
    line.derived,
    line.lineWeightLbs
  ]),
  [
    [15, 3, 3, null, false, true, 120],
    [26, 2, 2, null, false, true, 80]
  ]
);

const overridden = smartScmPhysicalPalletLines({
  ...proposal,
  palletQuantityOverrides: { 15: 1.25, 26: 0 }
}, palletItem);
assert.deepEqual(
  overridden.map((line) => [
    line.destinationLocationId,
    line.automaticQuantity,
    line.quantity,
    line.overrideQuantity,
    line.overridden,
    line.derived,
    line.lineWeightLbs
  ]),
  [
    [15, 3, 1.25, 1.25, true, false, 50],
    [26, 2, 0, 0, true, false, 0]
  ],
  "A numeric zero is an intentional override, while Reset is represented by an absent key."
);

const repositorySource = await fs.readFile(
  new URL("./smart-scm-planning-repository.js", import.meta.url),
  "utf8"
);
assert.match(
  repositorySource,
  /isNetSuitePoReview[\s\S]*new Set\(\["confirmed", "failed"\]\)[\s\S]*if \(!editableStatuses\.has\(current\.status\)\)/,
  "The generic PALLET endpoint must not bypass the NetSuite PO review status lock."
);
assert.match(
  repositorySource,
  /palletTransferQuantity > EPSILON && physicalPalletWeightLbs <= EPSILON/,
  "A positive TO PALLET quantity must require a trusted positive PALLET weight."
);

const proposalEditorSource = await fs.readFile(
  new URL("./smart-scm-proposal-editor.js", import.meta.url),
  "utf8"
);
assert.match(
  proposalEditorSource,
  /candidateLines[\s\S]*destination_location_id: destinationLocationId[\s\S]*proposalLoadWeight\(candidateLines/,
  "TO capacity validation must evaluate PALLET overrides against the edited destination."
);

console.log("Smart SCM PALLET override harness passed.");
