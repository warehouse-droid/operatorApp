import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conversionSource = fs.readFileSync(path.join(root, "src/scm-netsuite-po-unit-conversion.js"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "public/scm-netsuite-po.js"), "utf8");

async function conversionModule(source, name) {
  const encoded = Buffer.from(source).toString("base64");
  try {
    return await import(`data:text/javascript;base64,${encoded}#${encodeURIComponent(name)}`);
  } catch (error) {
    throw new Error(`Mutation ${name} did not compile: ${error.message}`);
  }
}

async function conversionMutation({ name, find, replace, verify }) {
  assert(conversionSource.includes(find), `Mutation target ${name} drifted out of the source.`);
  const mutated = conversionSource.replace(find, replace);
  const implementation = await conversionModule(mutated, name);
  let killedBy = null;
  try {
    await verify(implementation);
  } catch (error) {
    killedBy = error;
  }
  assert(killedBy, `Mutation survived: ${name}`);
  return name;
}

function renderCard(source, lifecycle) {
  const mount = {
    addEventListener() {},
    contains() { return false; },
    innerHTML: ""
  };
  const context = vm.createContext({
    console,
    confirm: () => true,
    document: {
      activeElement: null,
      visibilityState: "visible",
      addEventListener() {},
      getElementById: () => mount
    },
    requireDispatchLogin() {},
    setInterval() { return 1; },
    window: { addEventListener() {} }
  });
  vm.runInContext(source, context);
  context.__record = {
    id: 10,
    lifecycle,
    purchaseOrderRef: "PO-MUTATION-TEST",
    creationSnapshot: {},
    current: {
      active: lifecycle !== "missing",
      lines: [],
      status: lifecycle === "missing" ? "" : "B",
      statusText: lifecycle === "missing" ? "" : "Purchase Order : Pending Receipt",
      tranid: "PO-MUTATION-TEST"
    }
  };
  return vm.runInContext("poState.operator = { role: 'scm' }; card(__record)", context);
}

function verifyActionVisibility(source) {
  const missing = renderCard(source, "missing");
  assert.doesNotMatch(missing, /data-action="(?:pdf|refresh|save)"/);
  const active = renderCard(source, "active");
  for (const action of ["pdf", "refresh", "save"]) {
    assert.match(active, new RegExp(`data-action="${action}"`));
  }
}

const sqftLine = {
  itemName: "MBBS-Special Order",
  quantity: 217.95,
  unit: "SQFT",
  palletQuantity: 5,
  toPlt: null
};

const killed = [];
killed.push(await conversionMutation({
  name: "divide PLT instead of multiplying",
  find: "palletQuantity * conversion.unitsPerPallet",
  replace: "palletQuantity / conversion.unitsPerPallet",
  verify({ convertPurchaseOrderPalletQuantity }) {
    assert.equal(convertPurchaseOrderPalletQuantity(sqftLine, 6).nativeQuantity, 261.54);
  }
}));
killed.push(await conversionMutation({
  name: "prefer stale line ratio over item conversion",
  find: "configuredUnits > 0 ? configuredUnits : ratioUnits",
  replace: "ratioUnits > 0 ? ratioUnits : configuredUnits",
  verify({ describePurchaseOrderLinePallets }) {
    assert.equal(describePurchaseOrderLinePallets({ ...sqftLine, toPlt: 60 }).unitsPerPallet, 60);
  }
}));
killed.push(await conversionMutation({
  name: "stop recognizing the official PALLET item",
  find: '=== "PALLET";',
  replace: '=== "PALLETS";',
  verify({ describePurchaseOrderLinePallets }) {
    assert.equal(describePurchaseOrderLinePallets({ itemName: "PALLET", quantity: 5, unit: "EACH" }).ancillaryPallet, true);
  }
}));
killed.push(await conversionMutation({
  name: "allow zero PLT input",
  find: "palletQuantity <= 0",
  replace: "palletQuantity < 0",
  verify({ convertPurchaseOrderPalletQuantity }) {
    assert.throws(() => convertPurchaseOrderPalletQuantity(sqftLine, 0), /PLT quantity must be a positive number/);
  }
}));
killed.push(await conversionMutation({
  name: "truncate NetSuite quantity precision",
  find: "toFixed(QUANTITY_PRECISION)",
  replace: "toFixed(2)",
  verify({ convertPurchaseOrderPalletQuantity }) {
    assert.equal(convertPurchaseOrderPalletQuantity({ itemName: "Material", quantity: 1, unit: "EA", toPlt: 0.125 }, 0.25).nativeQuantity, 0.03125);
  }
}));
killed.push(await conversionMutation({
  name: "write custcol_plt on the ancillary PALLET line",
  find: "updatePalletColumn: false",
  replace: "updatePalletColumn: true",
  verify({ convertPurchaseOrderPalletQuantity }) {
    assert.equal(convertPurchaseOrderPalletQuantity({ itemName: "PALLET", quantity: 5, unit: "EACH" }, 6).updatePalletColumn, false);
  }
}));
killed.push(await conversionMutation({
  name: "allow an overflowing native quantity",
  find: "if (!Number.isFinite(nativeQuantity) || nativeQuantity <= 0)",
  replace: "if (false)",
  verify({ convertPurchaseOrderPalletQuantity }) {
    assert.throws(
      () => convertPurchaseOrderPalletQuantity({ ...sqftLine, toPlt: Number.MAX_VALUE }, Number.MAX_VALUE),
      /calculated native purchase quantity is invalid/i
    );
  }
}));

verifyActionVisibility(uiSource);
const uiGuard = 'const netSuiteExists = record.lifecycle !== "missing";';
assert(uiSource.includes(uiGuard), "Missing-PO action policy drifted out of the UI source.");
let uiKilledBy = null;
try {
  verifyActionVisibility(uiSource.replace(uiGuard, 'const netSuiteExists = record.lifecycle === "missing";'));
} catch (error) {
  uiKilledBy = error;
}
assert(uiKilledBy, "Mutation survived: invert missing-PO NetSuite action visibility");
killed.push("invert missing-PO NetSuite action visibility");

console.log(`NetSuite PO mutation harness passed: ${killed.length}/${killed.length} mutants killed.`);
