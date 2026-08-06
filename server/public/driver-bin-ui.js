(function driverBinUi(global) {
  "use strict";

  const JOB_SCHEMA = "mbt-driver-bin-job-v1";
  const EVENT_SCHEMA = "mbt-driver-bin-event-v1";
  const ASSET_ROLES = new Set(["expected", "outgoing", "incoming"]);
  const RECEIPT_FIELDS = [
    "ticketNumber", "weight", "quantity", "unitOfMeasure", "subtotal",
    "tax", "total"
  ];

  function error(code, message, details = {}) {
    const failure = new Error(message);
    failure.code = code;
    Object.assign(failure, details);
    return failure;
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function boundedText(value, maximum = 2_000) {
    return String(value ?? "").slice(0, maximum);
  }

  function versionParts(value) {
    const normalized = String(value || "").trim();
    if (!/^\d+(?:\.\d+)*$/u.test(normalized)) return null;
    const parts = normalized.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  }

  function clientVersionSatisfies(clientVersion, minimumVersion) {
    const client = versionParts(clientVersion);
    const minimum = versionParts(minimumVersion);
    if (!client || !minimum) return false;
    const length = Math.max(client.length, minimum.length);
    for (let index = 0; index < length; index += 1) {
      const left = client[index] || 0;
      const right = minimum[index] || 0;
      if (left > right) return true;
      if (left < right) return false;
    }
    return true;
  }

  function isBinJob(job) {
    return record(job).mbt?.schemaVersion === JOB_SCHEMA;
  }

  function inferredAssetRole(requirement) {
    const explicit = String(requirement.assetRole || "").trim().toLowerCase();
    if (ASSET_ROLES.has(explicit)) return explicit;
    const code = String(requirement.evidenceCode || "").toLowerCase();
    return ["outgoing", "incoming", "expected"].find((role) => code.includes(role)) || "expected";
  }

  function requirements(job) {
    if (!isBinJob(job)) return [];
    const assets = record(job.mbt.exactAssets);
    return (Array.isArray(job.mbt.evidenceRequirements) ? job.mbt.evidenceRequirements : [])
      .map((source) => {
        const requirement = record(source);
        const evidenceCode = String(requirement.evidenceCode || "").trim();
        const evidenceType = String(requirement.evidenceType || "").trim().toLowerCase();
        const minimumCount = Math.max(0, Math.floor(Number(requirement.minimumCount || 0)));
        const normalized = {
          evidenceCode,
          evidenceType,
          minimumCount,
          required: requirement.required === true,
          displayName: boundedText(requirement.displayName || evidenceCode, 200)
        };
        if (evidenceType !== "bin_scan") return normalized;
        const assetRole = inferredAssetRole(requirement);
        const asset = record(assets[assetRole]);
        return {
          ...normalized,
          assetRole,
          asset: {
            assetId: String(asset.assetId || ""),
            assetCode: String(asset.assetCode || ""),
            qrCode: String(asset.qrCode || ""),
            binTypeCode: String(asset.binTypeCode || "")
          },
          assetId: String(asset.assetId || ""),
          assetCode: String(asset.assetCode || ""),
          qrCode: String(asset.qrCode || "")
        };
      })
      .filter((requirement) => requirement.evidenceCode && requirement.evidenceType);
  }

  function photoSlots(job) {
    const slots = [];
    for (const requirement of requirements(job)) {
      if (!["photo", "signature"].includes(requirement.evidenceType)) continue;
      const count = Math.max(requirement.required ? 1 : 0, requirement.minimumCount);
      for (let index = 0; index < count; index += 1) {
        slots.push({
          evidenceCode: requirement.evidenceCode,
          evidenceType: requirement.evidenceType,
          requirementOrdinal: index,
          ordinal: slots.length,
          required: requirement.required
        });
      }
    }
    return slots;
  }

  function emptyReceipt() {
    return Object.fromEntries(RECEIPT_FIELDS.map((field) => [field, ""]));
  }

  function createDraft(job) {
    const draft = {
      schemaVersion: EVENT_SCHEMA,
      scans: {},
      notes: {},
      signatures: {},
      receipt: emptyReceipt()
    };
    for (const requirement of requirements(job)) {
      if (requirement.evidenceType === "bin_scan") draft.scans[requirement.evidenceCode] = "";
      if (requirement.evidenceType === "note") draft.notes[requirement.evidenceCode] = "";
      if (requirement.evidenceType === "signature") {
        draft.signatures[requirement.evidenceCode] = { signedBy: "" };
      }
    }
    return draft;
  }

  function normalizeDraft(job, value) {
    const source = record(value);
    const normalized = createDraft(job);
    const sourceScans = record(source.scans);
    const sourceNotes = record(source.notes);
    const sourceSignatures = record(source.signatures);
    for (const code of Object.keys(normalized.scans)) {
      normalized.scans[code] = boundedText(sourceScans[code], 200);
    }
    for (const code of Object.keys(normalized.notes)) {
      normalized.notes[code] = boundedText(sourceNotes[code], 2_000);
    }
    for (const code of Object.keys(normalized.signatures)) {
      normalized.signatures[code] = {
        signedBy: boundedText(record(sourceSignatures[code]).signedBy, 300)
      };
    }
    const sourceReceipt = record(source.receipt);
    for (const field of RECEIPT_FIELDS) {
      normalized.receipt[field] = boundedText(sourceReceipt[field], 200);
    }
    return normalized;
  }

  function draftKey(partitionKey, manifestId, jobId) {
    return `driverBinDraft::${String(partitionKey || "")}::${String(manifestId || "")}::${String(jobId || "")}`;
  }

  function normalizedIdentity(value) {
    return String(value || "").trim().toLowerCase();
  }

  function requiredValue(value, code, message, details = {}) {
    const normalized = String(value || "").trim();
    if (!normalized) throw error(code, message, details);
    return normalized;
  }

  function decimal(value, label) {
    const normalized = requiredValue(
      value,
      "DRIVER_BIN_RECEIPT_INCOMPLETE",
      `Enter the dump receipt ${label}.`
    );
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u.test(normalized)) {
      throw error("DRIVER_BIN_RECEIPT_INVALID", `The dump receipt ${label} is invalid.`);
    }
    return normalized;
  }

  function optionalDecimal(value, label) {
    return String(value || "").trim() ? decimal(value, label) : null;
  }

  function minorUnits(value, label) {
    const normalized = requiredValue(
      value,
      "DRIVER_BIN_RECEIPT_INCOMPLETE",
      `Enter the dump receipt ${label}.`
    );
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/u.test(normalized)) {
      throw error("DRIVER_BIN_RECEIPT_INVALID", `The dump receipt ${label} must use at most two decimal places.`);
    }
    const [whole, fraction = ""] = normalized.split(".");
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(result)) {
      throw error("DRIVER_BIN_RECEIPT_INVALID", `The dump receipt ${label} is too large.`);
    }
    return result;
  }

  function matchingAsset(requirement, scannedValue) {
    const expected = [requirement.assetId, requirement.assetCode, requirement.qrCode]
      .map(normalizedIdentity)
      .filter(Boolean);
    return expected.includes(normalizedIdentity(scannedValue));
  }

  function buildReceipt(job, draft, slots, photos) {
    const needsReceipt = requirements(job).some((item) => item.required && item.evidenceType === "receipt")
      || String(job.mbt.serviceAction || "").toLowerCase() === "dump"
      || String(job.mbt.actionCode || "").toLowerCase().includes("dump");
    if (!needsReceipt) return null;
    const source = record(draft.receipt);
    const receiptSlot = slots.find((slot) =>
      slot.evidenceType === "photo" && String(slot.evidenceCode).toLowerCase().includes("receipt")
    );
    if (!receiptSlot || !photos[receiptSlot.ordinal]) {
      throw error("DRIVER_BIN_EVIDENCE_MISSING", "Take the required dump receipt photo.", {
        evidenceCode: receiptSlot?.evidenceCode || "dump_receipt_photo"
      });
    }
    const weight = optionalDecimal(source.weight, "weight");
    const quantity = optionalDecimal(source.quantity, "quantity");
    if (weight === null && quantity === null) {
      throw error("DRIVER_BIN_RECEIPT_INCOMPLETE", "Enter the dump receipt weight or quantity.");
    }
    const subtotalMinor = minorUnits(source.subtotal, "subtotal");
    const taxMinor = minorUnits(source.tax, "tax");
    const totalMinor = minorUnits(source.total, "total");
    if (subtotalMinor + taxMinor !== totalMinor) {
      throw error("DRIVER_BIN_RECEIPT_TOTAL_MISMATCH", "The dump receipt total must equal subtotal plus tax.");
    }
    return {
      dumpSiteId: requiredValue(job.mbt.dumpSiteId, "DRIVER_BIN_RECEIPT_INCOMPLETE", "This work order has no frozen dump site."),
      materialId: requiredValue(job.mbt.materialId, "DRIVER_BIN_RECEIPT_INCOMPLETE", "This work order has no frozen material."),
      ticketNumber: requiredValue(source.ticketNumber, "DRIVER_BIN_RECEIPT_INCOMPLETE", "Enter the dump receipt ticket number."),
      weight,
      quantity,
      unitOfMeasure: requiredValue(source.unitOfMeasure, "DRIVER_BIN_RECEIPT_INCOMPLETE", "Enter the dump receipt unit of measure.").toUpperCase(),
      subtotalMinor,
      taxMinor,
      totalMinor,
      currency: "CAD",
      receiptPhotoOrdinal: receiptSlot.ordinal
    };
  }

  function buildCompletionDetails(job, draftValue, photosValue) {
    if (!isBinJob(job)) {
      throw error("DRIVER_BIN_JOB_INVALID", "A versioned BIN work order is required.");
    }
    const draft = normalizeDraft(job, draftValue);
    const photos = Array.isArray(photosValue) ? photosValue : [];
    const slots = photoSlots(job);
    const scans = [];
    const notes = [];
    const signatures = [];
    const photoEvidence = [];

    for (const requirement of requirements(job)) {
      if (requirement.evidenceType === "bin_scan") {
        const scannedValue = requiredValue(
          draft.scans[requirement.evidenceCode],
          "DRIVER_BIN_EVIDENCE_MISSING",
          "Scan or enter the required BIN asset.",
          { evidenceCode: requirement.evidenceCode }
        );
        if (!requirement.assetId || !matchingAsset(requirement, scannedValue)) {
          throw error("DRIVER_BIN_ASSET_MISMATCH", "The scanned BIN does not match this work order.", {
            evidenceCode: requirement.evidenceCode,
            assetRole: requirement.assetRole
          });
        }
        scans.push({
          evidenceCode: requirement.evidenceCode,
          assetRole: requirement.assetRole,
          assetId: requirement.assetId,
          scannedValue
        });
      }
      if (requirement.evidenceType === "note") {
        const text = String(draft.notes[requirement.evidenceCode] || "").trim();
        if (requirement.required && !text) {
          throw error("DRIVER_BIN_EVIDENCE_MISSING", "Enter the required Driver note.", {
            evidenceCode: requirement.evidenceCode
          });
        }
        if (text) notes.push({ evidenceCode: requirement.evidenceCode, text });
      }
      if (requirement.evidenceType === "photo") {
        for (const slot of slots.filter((item) =>
          item.evidenceType === "photo" && item.evidenceCode === requirement.evidenceCode
        )) {
          if (slot.required && !photos[slot.ordinal]) {
            throw error("DRIVER_BIN_EVIDENCE_MISSING", "Take every required work-order photo.", {
              evidenceCode: requirement.evidenceCode
            });
          }
          if (photos[slot.ordinal]) {
            photoEvidence.push({ evidenceCode: requirement.evidenceCode, ordinal: slot.ordinal });
          }
        }
      }
      if (requirement.evidenceType === "signature") {
        const signedBy = String(record(draft.signatures[requirement.evidenceCode]).signedBy || "").trim();
        const signatureSlot = slots.find((item) =>
          item.evidenceType === "signature" && item.evidenceCode === requirement.evidenceCode
        );
        if (requirement.required && (!signedBy || !signatureSlot || !photos[signatureSlot.ordinal])) {
          throw error("DRIVER_BIN_EVIDENCE_MISSING", "Enter the signer name and capture the required signature.", {
            evidenceCode: requirement.evidenceCode
          });
        }
        if (signedBy && signatureSlot && photos[signatureSlot.ordinal]) {
          signatures.push({
            evidenceCode: requirement.evidenceCode,
            signedBy,
            signaturePhotoOrdinal: signatureSlot.ordinal
          });
        }
      }
    }

    return {
      schemaVersion: EVENT_SCHEMA,
      actionCode: String(job.mbt.actionCode || ""),
      scans,
      photoEvidence,
      notes,
      signatures,
      receipt: buildReceipt(job, draft, slots, photos)
    };
  }

  function transferable(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  global.DriverBinUI = Object.freeze({
    JOB_SCHEMA,
    EVENT_SCHEMA,
    isBinJob,
    clientVersionSatisfies,
    requirements: (job) => transferable(requirements(job)),
    photoSlots: (job) => transferable(photoSlots(job)),
    createDraft: (job) => transferable(createDraft(job)),
    normalizeDraft: (job, value) => transferable(normalizeDraft(job, value)),
    draftKey,
    buildCompletionDetails: (job, draft, photos) => transferable(
      buildCompletionDetails(job, draft, photos)
    )
  });
})(typeof self !== "undefined" ? self : window);
