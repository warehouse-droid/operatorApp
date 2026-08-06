import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../../public");
const UI_PATH = path.join(PUBLIC, "driver-bin-ui.js");

const ASSET_OUT = "00000000-0000-4000-8000-000000000901";
const ASSET_IN = "00000000-0000-4000-8000-000000000902";
const DUMP_SITE = "00000000-0000-4000-8000-000000000903";
const MATERIAL = "00000000-0000-4000-8000-000000000904";

function loadDriverBinUi() {
  assert.equal(fs.existsSync(UI_PATH), true, "P3.9 requires public/driver-bin-ui.js.");
  const window = {};
  vm.runInNewContext(fs.readFileSync(UI_PATH, "utf8"), { window, structuredClone }, {
    filename: UI_PATH
  });
  assert.equal(typeof window.DriverBinUI, "object");
  return window.DriverBinUI;
}

function binJob(overrides = {}) {
  return {
    jobId: "p3-bin-job-1",
    requiredPhotos: 3,
    mbt: {
      schemaVersion: "mbt-driver-bin-job-v1",
      minimumClientVersion: "2026.08.03.1",
      actionCode: "exchange_bin",
      serviceAction: "exchange",
      visitReference: "BIN-P3-1-V1",
      binTypeCode: "14YD",
      exactAssets: {
        expected: null,
        outgoing: {
          assetId: ASSET_OUT,
          assetCode: "BIN-OUT-901",
          qrCode: "QR-BIN-OUT-901"
        },
        incoming: {
          assetId: ASSET_IN,
          assetCode: "BIN-IN-902",
          qrCode: "QR-BIN-IN-902"
        }
      },
      dumpSiteId: null,
      materialId: null,
      evidenceRequirements: [
        { evidenceCode: "outgoing_bin_scan", evidenceType: "bin_scan", minimumCount: 1, required: true },
        { evidenceCode: "incoming_bin_scan", evidenceType: "bin_scan", minimumCount: 1, required: true },
        { evidenceCode: "placement_photo", evidenceType: "photo", minimumCount: 2, required: true },
        { evidenceCode: "condition_note", evidenceType: "note", minimumCount: 1, required: true },
        { evidenceCode: "site_signature", evidenceType: "signature", minimumCount: 1, required: true }
      ]
    },
    ...overrides
  };
}

test("P3-F18: the browser recognizes only the versioned frozen BIN job contract", () => {
  const ui = loadDriverBinUi();
  assert.equal(ui.isBinJob(binJob()), true);
  assert.equal(ui.isBinJob({ mbt: { schemaVersion: "something-else" } }), false);
  assert.equal(ui.clientVersionSatisfies("2026.08.03.1", "2026.08.03.1"), true);
  assert.equal(ui.clientVersionSatisfies("2026.08.03.2", "2026.08.03.1"), true);
  assert.equal(ui.clientVersionSatisfies("2026.08.01.2", "2026.08.03.1"), false);
});

test("P3-F18/P3-F19: requirement slots remain code-mapped and exchange roles never collapse", () => {
  const ui = loadDriverBinUi();
  const requirements = ui.requirements(binJob());
  assert.deepEqual(
    requirements.filter(({ evidenceType }) => evidenceType === "bin_scan").map(({ evidenceCode, assetRole, assetId }) => ({ evidenceCode, assetRole, assetId })),
    [
      { evidenceCode: "outgoing_bin_scan", assetRole: "outgoing", assetId: ASSET_OUT },
      { evidenceCode: "incoming_bin_scan", assetRole: "incoming", assetId: ASSET_IN }
    ]
  );
  assert.deepEqual(
    ui.photoSlots(binJob()).map(({ evidenceCode, ordinal, evidenceType }) => ({ evidenceCode, ordinal, evidenceType })),
    [
      { evidenceCode: "placement_photo", ordinal: 0, evidenceType: "photo" },
      { evidenceCode: "placement_photo", ordinal: 1, evidenceType: "photo" },
      { evidenceCode: "site_signature", ordinal: 2, evidenceType: "signature" }
    ]
  );
});

test("P3-F18/P3-F22: completion builds exact scan, photo, note, and signature details", () => {
  const ui = loadDriverBinUi();
  const job = binJob();
  const draft = ui.createDraft(job);
  draft.scans.outgoing_bin_scan = "qr-bin-out-901";
  draft.scans.incoming_bin_scan = "BIN-IN-902";
  draft.notes.condition_note = "No visible damage";
  draft.signatures.site_signature = { signedBy: "Site Receiver" };
  const photos = [{ photoId: "photo-0" }, { photoId: "photo-1" }, { photoId: "photo-2" }];

  assert.deepEqual(ui.buildCompletionDetails(job, draft, photos), {
    schemaVersion: "mbt-driver-bin-event-v1",
    actionCode: "exchange_bin",
    scans: [
      { evidenceCode: "outgoing_bin_scan", assetRole: "outgoing", assetId: ASSET_OUT, scannedValue: "qr-bin-out-901" },
      { evidenceCode: "incoming_bin_scan", assetRole: "incoming", assetId: ASSET_IN, scannedValue: "BIN-IN-902" }
    ],
    photoEvidence: [
      { evidenceCode: "placement_photo", ordinal: 0 },
      { evidenceCode: "placement_photo", ordinal: 1 }
    ],
    notes: [{ evidenceCode: "condition_note", text: "No visible damage" }],
    signatures: [{ evidenceCode: "site_signature", signedBy: "Site Receiver", signaturePhotoOrdinal: 2 }],
    receipt: null
  });

  draft.scans.incoming_bin_scan = "WRONG-BIN";
  assert.throws(
    () => ui.buildCompletionDetails(job, draft, photos),
    (error) => error?.code === "DRIVER_BIN_ASSET_MISMATCH" && error?.evidenceCode === "incoming_bin_scan"
  );
});

test("P3-F21: a dump completion retains frozen IDs, precise quantities, integer cents, and receipt photo", () => {
  const ui = loadDriverBinUi();
  const job = binJob({
    requiredPhotos: 1,
    mbt: {
      ...binJob().mbt,
      actionCode: "dump_bin",
      serviceAction: "dump",
      exactAssets: { expected: null, outgoing: null, incoming: null },
      dumpSiteId: DUMP_SITE,
      materialId: MATERIAL,
      evidenceRequirements: [
        { evidenceCode: "dump_receipt", evidenceType: "receipt", minimumCount: 1, required: true },
        { evidenceCode: "dump_receipt_photo", evidenceType: "photo", minimumCount: 1, required: true }
      ]
    }
  });
  const draft = ui.createDraft(job);
  Object.assign(draft.receipt, {
    ticketNumber: "TICKET-P3-21",
    weight: "1.250",
    quantity: "2",
    unitOfMeasure: "TONNE",
    subtotal: "100.05",
    tax: "13.01",
    total: "113.06"
  });
  const result = ui.buildCompletionDetails(job, draft, [{ photoId: "receipt-photo" }]);
  assert.deepEqual(result.receipt, {
    dumpSiteId: DUMP_SITE,
    materialId: MATERIAL,
    ticketNumber: "TICKET-P3-21",
    weight: "1.250",
    quantity: "2",
    unitOfMeasure: "TONNE",
    subtotalMinor: 10005,
    taxMinor: 1301,
    totalMinor: 11306,
    currency: "CAD",
    receiptPhotoOrdinal: 0
  });
  assert.deepEqual(result.photoEvidence, [{ evidenceCode: "dump_receipt_photo", ordinal: 0 }]);

  draft.receipt.total = "113.07";
  assert.throws(
    () => ui.buildCompletionDetails(job, draft, [{ photoId: "receipt-photo" }]),
    (error) => error?.code === "DRIVER_BIN_RECEIPT_TOTAL_MISMATCH"
  );
});

test("P3-F19/P3-F20: draft keys isolate driver, manifest, and job while normalization ignores unknown data", () => {
  const ui = loadDriverBinUi();
  assert.equal(
    ui.draftKey("driver::device", "manifest-1", "job-1"),
    "driverBinDraft::driver::device::manifest-1::job-1"
  );
  const normalized = ui.normalizeDraft(binJob(), {
    scans: { outgoing_bin_scan: "A", not_in_manifest: "B" },
    notes: { condition_note: "Saved locally", unknown_note: "drop" },
    signatures: { site_signature: { signedBy: "Receiver", injected: true } },
    receipt: { ticketNumber: "draft", injected: true },
    injectedTopLevel: true
  });
  assert.equal(normalized.scans.outgoing_bin_scan, "A");
  assert.equal("not_in_manifest" in normalized.scans, false);
  assert.deepEqual(normalized.signatures.site_signature, { signedBy: "Receiver" });
  assert.equal("injected" in normalized.receipt, false);
  assert.equal("injectedTopLevel" in normalized, false);
});

test("P3-F18/P3-F22 static seam: Driver loads BIN UI offline and starts BIN jobs only through the local event ledger", () => {
  const driver = fs.readFileSync(path.join(PUBLIC, "driver.js"), "utf8");
  const html = fs.readFileSync(path.join(PUBLIC, "driver.html"), "utf8");
  const worker = fs.readFileSync(path.join(PUBLIC, "driver-service-worker.js"), "utf8");
  const i18n = fs.readFileSync(path.join(PUBLIC, "i18n.js"), "utf8");

  assert.match(html, /driver-bin-ui\.js/u);
  assert.match(worker, /driver-bin-ui\.js/u);
  assert.match(driver, /function isDriverBinJob\(/u);
  assert.match(driver, /if \(isDriverBinJob\(startedJob\)\)[\s\S]{0,500}deferSync: false/u);
  assert.match(driver, /buildCompletionDetails\(completedJob, binDraft, submittedJobPhotos\)/u);
  assert.match(driver, /not_checked_offline/u);
  for (const key of [
    "driver.binWorkOrder",
    "driver.binOutgoingScan",
    "driver.binIncomingScan",
    "driver.binReceiptTicket",
    "driver.binSignerName",
    "driver.binSavedOnDevice"
  ]) {
    assert.match(i18n, new RegExp(`"${key.replaceAll(".", "\\.")}"\\s*:`));
  }
});
