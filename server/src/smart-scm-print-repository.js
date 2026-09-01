import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

function text(value) {
  return String(value ?? "").trim();
}

const YARD_PRINTER_SLOTS = Object.freeze([1, 2]);
const TRANSFER_ORDER_DOCUMENT_TYPES = new Set(["picking_ticket", "transfer_dependency_picking_ticket"]);
const SALES_ORDER_DOCUMENT_TYPES = new Set(["sales_order_picking_ticket"]);

function printerNameList(value) {
  const values = Array.isArray(value) ? value : [];
  const seen = new Set();
  const names = [];
  for (const entry of values) {
    const name = text(entry);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function inputBinValue(value, { strict = false, field = "Input bin" } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const supportedType = typeof value === "number" || typeof value === "string";
  const rawValue = supportedType ? String(value).trim() : "";
  const inputBin = Number(rawValue);
  if (/^\d+$/.test(rawValue) && Number.isInteger(inputBin) && inputBin >= 1 && inputBin <= 65535) return inputBin;
  const error = new Error(`${field} must be a whole-number Windows RawKind value from 1 to 65535.`);
  if (strict) error.status = 400;
  throw error;
}

function printerTargetList(value) {
  const values = Array.isArray(value) ? value : [];
  const seen = new Set();
  const targets = [];
  for (const entry of values) {
    const printerName = text(typeof entry === "string" ? entry : entry?.printerName ?? entry?.name);
    const key = printerName.toLowerCase();
    if (!printerName || seen.has(key)) continue;
    seen.add(key);
    targets.push({
      printerName,
      inputBin: typeof entry === "string" ? null : inputBinValue(entry?.inputBin)
    });
  }
  return targets;
}

function yardPrinterDestinations(row = {}) {
  const settings = row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
    ? row.settings
    : {};
  const configured = Array.isArray(settings.printers) ? settings.printers : [];
  const bySlot = new Map(configured.map((printer) => [Number(printer?.slot), printer]));
  const legacyName = text(row.printer_name);
  return YARD_PRINTER_SLOTS.map((slot) => {
    const configuredPrinter = bySlot.get(slot);
    const isLegacyPrimary = !configured.length && slot === 1 && Boolean(legacyName);
    return {
      slot,
      printerName: text(configuredPrinter?.printerName ?? configuredPrinter?.name ?? (slot === 1 ? legacyName : "")),
      inputBin: inputBinValue(configuredPrinter?.inputBin),
      printTransferOrders: configuredPrinter
        ? Boolean(configuredPrinter.printTransferOrders)
        : isLegacyPrimary,
      printSalesOrders: configuredPrinter
        ? Boolean(configuredPrinter.printSalesOrders)
        : isLegacyPrimary
    };
  });
}

function normalizedPrinterDestinations(values, currentRow) {
  if (values.printers === undefined && values.settings?.printers === undefined) {
    if (values.printerName === undefined) return yardPrinterDestinations(currentRow);
    if (Array.isArray(currentRow.settings?.printers)) {
      return yardPrinterDestinations(currentRow).map((printer) => printer.slot === 1
        ? { ...printer, printerName: text(values.printerName) }
        : printer);
    }
    return [
      {
        slot: 1,
        printerName: text(values.printerName),
        inputBin: null,
        printTransferOrders: true,
        printSalesOrders: true
      },
      {
        slot: 2,
        printerName: "",
        inputBin: null,
        printTransferOrders: false,
        printSalesOrders: false
      }
    ];
  }
  const supplied = values.printers ?? values.settings?.printers;
  if (!Array.isArray(supplied)) {
    throw Object.assign(new Error("Printer setup must contain Printer 1 and Printer 2."), { status: 400 });
  }
  const bySlot = new Map();
  for (const entry of supplied) {
    const slot = Number(entry?.slot);
    if (!YARD_PRINTER_SLOTS.includes(slot) || bySlot.has(slot)) {
      throw Object.assign(new Error("Each yard printer slot must be 1 or 2 and may appear only once."), { status: 400 });
    }
    bySlot.set(slot, entry);
  }
  const printers = YARD_PRINTER_SLOTS.map((slot) => {
    const entry = bySlot.get(slot) || {};
    return {
      slot,
      printerName: text(entry.printerName ?? entry.name),
      inputBin: inputBinValue(entry.inputBin, { strict: true, field: `Printer ${slot} input bin` }),
      printTransferOrders: Boolean(entry.printTransferOrders),
      printSalesOrders: Boolean(entry.printSalesOrders)
    };
  });
  for (const printer of printers) {
    if (!printer.printerName && (printer.printTransferOrders || printer.printSalesOrders)) {
      throw Object.assign(new Error(`Enter a Windows printer name before assigning Printer ${printer.slot} to TO or SO printing.`), { status: 400 });
    }
    if (!printer.printerName && printer.inputBin !== null) {
      throw Object.assign(new Error(`Enter a Windows printer name before setting Printer ${printer.slot}'s input bin.`), { status: 400 });
    }
  }
  const named = printers.filter((printer) => printer.printerName);
  if (new Set(named.map((printer) => printer.printerName.toLowerCase())).size !== named.length) {
    throw Object.assign(new Error("Printer 1 and Printer 2 must use different Windows printer names."), { status: 400 });
  }
  if (printers.filter((printer) => printer.printerName && printer.printSalesOrders).length > 1) {
    throw Object.assign(new Error("SO printing must be assigned to exactly one printer per yard."), { status: 400 });
  }
  return printers;
}

function routedPrinterTargets(row, documentType) {
  const printers = yardPrinterDestinations(row);
  if (TRANSFER_ORDER_DOCUMENT_TYPES.has(documentType)) {
    return printerTargetList(printers
      .filter((printer) => printer.printTransferOrders)
      .map(({ printerName, inputBin }) => ({ printerName, inputBin })));
  }
  if (SALES_ORDER_DOCUMENT_TYPES.has(documentType)) {
    return printerTargetList(printers
      .filter((printer) => printer.printSalesOrders)
      .map(({ printerName, inputBin }) => ({ printerName, inputBin })));
  }
  return [];
}

function configuredPrinterTargets(row, requestedNames = []) {
  const byName = new Map(yardPrinterDestinations(row)
    .filter((destination) => destination.printerName)
    .map((destination) => [destination.printerName.toLowerCase(), {
      printerName: destination.printerName,
      inputBin: destination.inputBin
    }]));
  return printerNameList(requestedNames)
    .map((printerName) => byName.get(printerName.toLowerCase()))
    .filter(Boolean);
}

function safeAgentDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > 30720) {
      return { diagnosticsOmitted: "Printer-agent diagnostics exceeded 30 KB." };
    }
    return JSON.parse(serialized);
  } catch {
    return { diagnosticsOmitted: "Printer-agent diagnostics were not valid JSON." };
  }
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeDocumentName(value) {
  return path.basename(text(value) || "document.pdf").replace(/[^a-zA-Z0-9._() -]+/g, "_").slice(0, 180);
}

function pdfEscape(value) {
  return String(value || "").replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function createSimplePdf(lines = []) {
  const clean = lines.slice(0, 28).map((line) => pdfEscape(line));
  const streamLines = ["BT", "/F1 15 Tf", "50 750 Td"];
  clean.forEach((line, index) => {
    if (index) streamLines.push("0 -24 Td");
    streamLines.push(`(${line}) Tj`);
  });
  streamLines.push("ET");
  const stream = `${streamLines.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

function publicPrinter(row) {
  let status = row.enabled ? row.status : "disabled";
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  if (status === "online" && (!lastSeen || Date.now() - lastSeen > 120000)) status = "offline";
  const printers = yardPrinterDestinations(row);
  const transferOrderPrinterNames = printerNameList(printers
    .filter((printer) => printer.printTransferOrders)
    .map((printer) => printer.printerName));
  const salesOrderPrinterNames = printerNameList(printers
    .filter((printer) => printer.printSalesOrders)
    .map((printer) => printer.printerName));
  const hasToken = Boolean(row.agent_token_hash);
  const enabled = Boolean(row.enabled);
  return {
    locationId: Number(row.location_id),
    yardCode: row.yard_code,
    printerName: salesOrderPrinterNames[0] || printers.find((printer) => printer.printerName)?.printerName || "",
    printers,
    transferOrderPrinterNames,
    salesOrderPrinterNames,
    transferOrderReady: enabled && hasToken && transferOrderPrinterNames.length === 2,
    salesOrderReady: enabled && hasToken && salesOrderPrinterNames.length === 1,
    agentId: row.agent_id,
    agentVersion: Math.max(1, Number(row.agent_version || 1)),
    hasToken,
    enabled,
    status,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    settings: { ...(row.settings || {}), printers },
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

function publicJob(row) {
  const legacyPrinterNames = printerNameList(row.printer_names);
  if (!legacyPrinterNames.length && row.printer_name) legacyPrinterNames.push(text(row.printer_name));
  const printerTargets = printerTargetList(row.printer_targets);
  if (!printerTargets.length) {
    printerTargets.push(...legacyPrinterNames.map((printerName) => ({ printerName, inputBin: null })));
  }
  const printerNames = printerTargets.map((target) => target.printerName);
  const agentDiagnostics = row.agent_diagnostics && typeof row.agent_diagnostics === "object" && !Array.isArray(row.agent_diagnostics)
    ? row.agent_diagnostics
    : {};
  return {
    id: Number(row.id),
    jobKey: row.job_key,
    proposalId: row.proposal_id === null ? null : Number(row.proposal_id),
    locationId: Number(row.location_id),
    yardCode: row.yard_code,
    printerName: printerNames[0] || "",
    printerNames,
    printerTargets,
    copyCount: printerNames.length,
    documentType: row.document_type,
    documentName: row.document_name,
    documentSha256: row.document_sha256,
    sourceOrderId: row.source_order_id === null || row.source_order_id === undefined ? null : Number(row.source_order_id),
    sourceOrderRef: row.source_order_ref || "",
    lineLocationId: row.line_location_id === null || row.line_location_id === undefined ? null : Number(row.line_location_id),
    requestedCompanyName: row.requested_company_name || "",
    requestedIpAddress: row.requested_ip_address || "",
    status: row.status,
    attempts: Number(row.attempts || 0),
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    printedAt: row.printed_at,
    agentDiagnostics,
    updatedAt: row.updated_at
  };
}

export async function listYardPrinters() {
  const result = await query("SELECT * FROM scm_yard_printers ORDER BY CASE yard_code WHEN '3445' THEN 1 WHEN '2967' THEN 2 WHEN '12441' THEN 3 WHEN '150' THEN 4 ELSE 5 END");
  return result.rows.map(publicPrinter);
}

export async function updateYardPrinter(locationId, values = {}, operatorId = null) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error("Select a valid yard."), { status: 400 });
  const current = await query("SELECT * FROM scm_yard_printers WHERE location_id = $1", [id]);
  if (!current.rowCount) throw Object.assign(new Error("Yard printer was not found."), { status: 404 });
  const printers = normalizedPrinterDestinations(values, current.rows[0]);
  const printerName = printers[0].printerName;
  const enabled = values.enabled === undefined ? Boolean(current.rows[0].enabled) : Boolean(values.enabled);
  if (enabled && !printers.some((printer) => printer.printerName)) {
    throw Object.assign(new Error("At least one printer name is required before enabling this yard."), { status: 400 });
  }
  const suppliedSettings = values.settings && typeof values.settings === "object" && !Array.isArray(values.settings)
    ? values.settings
    : {};
  const settings = { ...(current.rows[0].settings || {}), ...suppliedSettings, printers };
  const result = await query(
    `UPDATE scm_yard_printers
        SET printer_name = $2,
            enabled = $3,
            status = CASE WHEN $3 = false THEN 'disabled' WHEN agent_token_hash IS NULL THEN 'not_configured' ELSE 'offline' END,
            settings = $4::jsonb,
            updated_by = $5,
            updated_at = now()
      WHERE location_id = $1
      RETURNING *`,
    [id, printerName, enabled, JSON.stringify(settings), operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.printer.update",
    details: {
      locationId: id,
      yardCode: result.rows[0].yard_code,
      enabled,
      printers,
      transferOrderPrinterNames: printers
        .filter((printer) => printer.printTransferOrders)
        .map((printer) => printer.printerName),
      salesOrderPrinterNames: printers
        .filter((printer) => printer.printSalesOrders)
        .map((printer) => printer.printerName)
    }
  });
  return publicPrinter(result.rows[0]);
}

export async function rotateYardPrinterToken(locationId, operatorId = null) {
  const token = crypto.randomBytes(32).toString("base64url");
  const result = await query(
    `UPDATE scm_yard_printers
        SET agent_token_hash = $2,
            status = CASE WHEN enabled THEN 'offline' ELSE 'disabled' END,
            last_error = NULL,
            updated_by = $3,
            updated_at = now()
      WHERE location_id = $1
      RETURNING *`,
    [Number(locationId), hashToken(token), operatorId]
  );
  if (!result.rowCount) throw Object.assign(new Error("Yard printer was not found."), { status: 404 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.printer.token_rotate",
    details: { locationId: Number(locationId), yardCode: result.rows[0].yard_code, agentId: result.rows[0].agent_id }
  });
  return { printer: publicPrinter(result.rows[0]), token };
}

export async function authenticateYardPrinterAgent(token, agentId = "") {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const params = [tokenHash];
  let clause = "agent_token_hash = $1";
  if (agentId) {
    params.push(text(agentId));
    clause += " AND agent_id = $2";
  }
  const result = await query(`SELECT * FROM scm_yard_printers WHERE ${clause}`, params);
  const printer = result.rows[0];
  if (!printer || !safeEqual(printer.agent_token_hash, tokenHash) || !printer.enabled) return null;
  await query(
    `UPDATE scm_yard_printers
        SET status = 'online', last_seen_at = now(), last_error = NULL
      WHERE location_id = $1
        AND (
          status IS DISTINCT FROM 'online'
          OR last_error IS NOT NULL
          OR last_seen_at IS NULL
          OR last_seen_at < now() - interval '1 minute'
        )`,
    [printer.location_id]
  );
  return printer;
}

export async function queueSmartScmPrintJob({
  proposalId = null,
  locationId,
  documentType = "picking_ticket",
  documentName,
  documentBuffer,
  jobKey = null,
  sourceOrderId = null,
  sourceOrderRef = "",
  lineLocationId = null,
  requestedCompanyName = "",
  requestedIpAddress = "",
  printerNames = null
}, operatorId = null) {
  const id = Number(locationId);
  const printer = await query("SELECT * FROM scm_yard_printers WHERE location_id = $1", [id]);
  if (!printer.rowCount) throw Object.assign(new Error("The source yard has no printer setup row."), { status: 409 });
  const printerRow = printer.rows[0];
  if (!printerRow.enabled) throw Object.assign(new Error(`${printerRow.yard_code} printer queue is disabled.`), { status: 409 });
  if (!printerRow.agent_token_hash) throw Object.assign(new Error(`${printerRow.yard_code} printer agent token has not been generated.`), { status: 409 });
  const configuredNames = printerNameList(yardPrinterDestinations(printerRow).map((entry) => entry.printerName));
  const requestedNames = printerNames === null ? [] : printerNameList(printerNames);
  if (requestedNames.some((name) => !configuredNames.some((configured) => configured.toLowerCase() === name.toLowerCase()))) {
    throw Object.assign(new Error("The requested printer is not configured for this yard."), { status: 400 });
  }
  const targetPrinterTargets = requestedNames.length
    ? configuredPrinterTargets(printerRow, requestedNames)
    : routedPrinterTargets(printerRow, documentType);
  const targetPrinterNames = targetPrinterTargets.map((target) => target.printerName);
  if (TRANSFER_ORDER_DOCUMENT_TYPES.has(documentType) && targetPrinterNames.length !== 2) {
    throw Object.assign(new Error(`${printerRow.yard_code} requires two different printers assigned to TO printing.`), { status: 409 });
  }
  if (SALES_ORDER_DOCUMENT_TYPES.has(documentType) && targetPrinterNames.length !== 1) {
    throw Object.assign(new Error(`${printerRow.yard_code} requires exactly one printer assigned to SO printing.`), { status: 409 });
  }
  if (!targetPrinterNames.length) {
    throw Object.assign(new Error(`No printer is configured for this ${documentType} job at ${printerRow.yard_code}.`), { status: 409 });
  }
  if (!Buffer.isBuffer(documentBuffer) || !documentBuffer.length) throw new Error("Print document is empty.");
  await fs.mkdir(config.smartScm.printDir, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(documentBuffer).digest("hex");
  const resolvedKey = jobKey || `smart-scm:${proposalId || "manual"}:${documentType}:${sha256.slice(0, 16)}`;
  const filename = `${Date.now()}-${crypto.randomUUID()}-${safeDocumentName(documentName)}`;
  const documentPath = path.join(config.smartScm.printDir, filename);
  await fs.writeFile(documentPath, documentBuffer, { flag: "wx" });
  let result;
  try {
    result = await query(
      `INSERT INTO scm_print_jobs (
         job_key, proposal_id, location_id, document_type, document_name, document_path, document_sha256,
         source_order_id, source_order_ref, line_location_id, queued_by_operator_id,
         requested_company_name, requested_ip_address, printer_names, printer_targets
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
       ON CONFLICT (job_key) DO UPDATE
         SET updated_at = scm_print_jobs.updated_at
       RETURNING *`,
      [
        resolvedKey,
        proposalId,
        id,
        documentType,
        safeDocumentName(documentName),
        documentPath,
        sha256,
        sourceOrderId ? Number(sourceOrderId) : null,
        text(sourceOrderRef) || null,
        lineLocationId ? Number(lineLocationId) : null,
        operatorId || null,
        text(requestedCompanyName) || null,
        text(requestedIpAddress) || null,
        JSON.stringify(targetPrinterNames),
        JSON.stringify(targetPrinterTargets)
      ]
    );
  } catch (error) {
    await fs.unlink(documentPath).catch(() => null);
    throw error;
  }
  if (result.rows[0].document_path !== documentPath) await fs.unlink(documentPath).catch(() => null);
  const queuedJob = publicJob({ ...result.rows[0], yard_code: printerRow.yard_code, printer_name: printerRow.printer_name });
  await writeAudit({
    actorType: operatorId ? "operator" : text(requestedCompanyName) ? "anonymous" : "system",
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.print.queued",
    details: {
      printJobId: Number(result.rows[0].id),
      proposalId,
      locationId: id,
      documentType,
      documentName,
      sourceOrderId: sourceOrderId ? Number(sourceOrderId) : null,
      sourceOrderRef: text(sourceOrderRef) || null,
      lineLocationId: lineLocationId ? Number(lineLocationId) : null,
      requestedCompanyName: text(requestedCompanyName) || null,
      requestedIpAddress: text(requestedIpAddress) || null,
      printerNames: queuedJob.printerNames,
      printerTargets: queuedJob.printerTargets,
      sha256
    }
  });
  return queuedJob;
}

export async function queueYardPrinterTest(locationId, operatorId = null, printerSlot = 1) {
  const printer = await query("SELECT * FROM scm_yard_printers WHERE location_id = $1", [Number(locationId)]);
  if (!printer.rowCount) throw Object.assign(new Error("Yard printer was not found."), { status: 404 });
  const row = printer.rows[0];
  const slot = Number(printerSlot);
  const destination = yardPrinterDestinations(row).find((entry) => entry.slot === slot);
  if (!destination?.printerName) throw Object.assign(new Error(`Printer ${slot} is not configured for this yard.`), { status: 409 });
  const pdf = createSimplePdf([
    "MBBS Smart SCM Printer Test",
    `Yard: ${row.yard_code}`,
    `Printer ${slot}: ${destination.printerName}`,
    `Input bin: ${destination.inputBin ?? "queue default"}`,
    `Agent: ${row.agent_id}`,
    `Queued: ${new Date().toISOString()}`
  ]);
  return queueSmartScmPrintJob({
    locationId: row.location_id,
    documentType: "test",
    documentName: `MBBS-${row.yard_code}-printer-test.pdf`,
    documentBuffer: pdf,
    jobKey: `printer-test:${row.location_id}:${slot}:${Date.now()}`,
    printerNames: [destination.printerName]
  }, operatorId);
}

export async function listSmartScmPrintJobs({ locationId = null, status = "", limit = 200 } = {}) {
  const params = [];
  const clauses = [];
  if (locationId) {
    params.push(Number(locationId));
    clauses.push(`j.location_id = $${params.length}`);
  }
  if (status) {
    params.push(String(status));
    clauses.push(`j.status = $${params.length}`);
  }
  params.push(Math.min(1000, Math.max(1, Number(limit) || 200)));
  const result = await query(
    `SELECT j.*, p.yard_code, p.printer_name
       FROM scm_print_jobs j
       JOIN scm_yard_printers p ON p.location_id = j.location_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY j.id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map(publicJob);
}

async function reclaimExpiredPrintJobs(locationId) {
  await query(
    `UPDATE scm_print_jobs
        SET status = CASE WHEN started_at IS NULL THEN 'queued' ELSE 'uncertain' END,
            lease_token_hash = NULL,
            lease_expires_at = NULL,
            leased_by = NULL,
            last_error = CASE WHEN started_at IS NULL THEN last_error ELSE 'Agent lease expired after printing began; verify before reprint.' END,
            updated_at = now()
      WHERE location_id = $1
        AND status IN ('leased', 'printing')
        AND lease_expires_at < now()`,
    [Number(locationId)]
  );
}

export async function leaseYardPrintJob(agentToken, agentId = "", agentVersion = 1) {
  const printer = await authenticateYardPrinterAgent(agentToken, agentId);
  if (!printer) throw Object.assign(new Error("Valid enabled printer-agent credentials are required."), { status: 401 });
  const reportedAgentVersion = Math.min(1000, Math.max(1, Math.floor(Number(agentVersion) || 1)));
  await query(
    `UPDATE scm_yard_printers
        SET agent_version = $2
      WHERE location_id = $1
        AND agent_version IS DISTINCT FROM $2`,
    [printer.location_id, reportedAgentVersion]
  );
  printer.agent_version = reportedAgentVersion;
  await reclaimExpiredPrintJobs(printer.location_id);
  const lease = await withTransaction(async () => {
    const selected = await query(
      `SELECT * FROM scm_print_jobs
        WHERE location_id = $1 AND status = 'queued'
        ORDER BY queued_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [printer.location_id]
    );
    if (!selected.rowCount) return { job: null, pollAfterSeconds: 10 };
    let selectedJob = selected.rows[0];
    let targetPrinters = printerTargetList(selectedJob.printer_targets);
    if (!targetPrinters.length) {
      targetPrinters = printerNameList(selectedJob.printer_names)
        .map((printerName) => ({ printerName, inputBin: null }));
    }
    if (TRANSFER_ORDER_DOCUMENT_TYPES.has(selectedJob.document_type) && targetPrinters.length !== 2) {
      const currentTargets = routedPrinterTargets(printer, selectedJob.document_type);
      if (currentTargets.length !== 2) {
        return {
          blocked: true,
          message: `${printer.yard_code} requires two different printers assigned to TO printing before this queued job can print.`
        };
      }
      const rerouted = await query(
        `UPDATE scm_print_jobs
            SET printer_names = $2::jsonb, printer_targets = $3::jsonb, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [selectedJob.id, JSON.stringify(currentTargets.map((target) => target.printerName)), JSON.stringify(currentTargets)]
      );
      selectedJob = rerouted.rows[0];
      targetPrinters = currentTargets;
    }
    if (targetPrinters.length > 1 && reportedAgentVersion < 2) {
      return {
        blocked: true,
        message: "Update the MBBS Yard Printer Agent before printing a two-printer TO job."
      };
    }
    if (targetPrinters.some((target) => target.inputBin !== null) && reportedAgentVersion < 3) {
      return {
        blocked: true,
        message: "Update the MBBS Yard Printer Agent to v3 before printing jobs with input-bin routing."
      };
    }
    const leaseToken = crypto.randomBytes(24).toString("base64url");
    const updated = await query(
      `UPDATE scm_print_jobs
          SET status = 'leased', attempts = attempts + 1,
              lease_token_hash = $2, lease_expires_at = now() + interval '5 minutes',
              leased_by = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [selectedJob.id, hashToken(leaseToken), printer.agent_id]
    );
    return {
      job: {
        ...publicJob({ ...updated.rows[0], yard_code: printer.yard_code, printer_name: printer.printer_name }),
        leaseToken,
        downloadUrl: `/api/scm/print-agent/jobs/${updated.rows[0].id}/document`
      },
      pollAfterSeconds: 2
    };
  });
  if (lease.blocked) {
    await query(
      `UPDATE scm_yard_printers
          SET status = 'error', last_error = $2, updated_at = now()
        WHERE location_id = $1`,
      [printer.location_id, lease.message]
    );
    throw Object.assign(new Error(lease.message), { status: 409 });
  }
  return lease;
}

async function leasedJob(jobId, printer, leaseToken) {
  const result = await query(
    `SELECT * FROM scm_print_jobs
      WHERE id = $1 AND location_id = $2 AND leased_by = $3
        AND lease_token_hash = $4 AND lease_expires_at > now()`,
    [Number(jobId), printer.location_id, printer.agent_id, hashToken(leaseToken)]
  );
  return result.rows[0] || null;
}

export async function yardPrintJobDocument(jobId, agentToken, agentId, leaseToken) {
  const printer = await authenticateYardPrinterAgent(agentToken, agentId);
  if (!printer) throw Object.assign(new Error("Printer-agent authorization failed."), { status: 401 });
  const job = await leasedJob(jobId, printer, leaseToken);
  if (!job) throw Object.assign(new Error("Print-job lease is invalid or expired."), { status: 409 });
  return { path: job.document_path, filename: job.document_name };
}

export async function updateLeasedPrintJob(jobId, agentToken, agentId, leaseToken, action, details = {}) {
  const printer = await authenticateYardPrinterAgent(agentToken, agentId);
  if (!printer) throw Object.assign(new Error("Printer-agent authorization failed."), { status: 401 });
  const job = await leasedJob(jobId, printer, leaseToken);
  if (!job) throw Object.assign(new Error("Print-job lease is invalid or expired."), { status: 409 });
  const actions = {
    started: { status: "printing", error: null, printed: false },
    heartbeat: { status: "printing", error: null, printed: false },
    completed: { status: "printed", error: null, printed: true },
    failed: { status: "failed", error: text(details.error) || "Printer agent reported a failure.", printed: false },
    uncertain: { status: "uncertain", error: text(details.error) || "Printer result is uncertain.", printed: false }
  };
  const next = actions[action];
  if (!next) throw Object.assign(new Error("Invalid print-agent action."), { status: 400 });
  const diagnostics = safeAgentDiagnostics({
    ...safeAgentDiagnostics(details.diagnostics),
    lastAction: action,
    serverReportedAt: new Date().toISOString()
  });
  const result = await query(
    `UPDATE scm_print_jobs
        SET status = $2,
            started_at = CASE WHEN $2 IN ('printing', 'printed') THEN COALESCE(started_at, now()) ELSE started_at END,
            printed_at = CASE WHEN $3 THEN now() ELSE printed_at END,
            last_error = $4,
            agent_diagnostics = $5::jsonb,
            lease_expires_at = CASE WHEN $2 = 'printing' THEN now() + interval '10 minutes' ELSE NULL END,
            lease_token_hash = CASE WHEN $2 = 'printing' THEN lease_token_hash ELSE NULL END,
            leased_by = CASE WHEN $2 = 'printing' THEN leased_by ELSE NULL END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [job.id, next.status, next.printed, next.error, JSON.stringify(diagnostics)]
  );
  if (next.status === "failed") {
    await query("UPDATE scm_yard_printers SET status = 'error', last_error = $2 WHERE location_id = $1", [printer.location_id, next.error]);
  }
  if (action !== "heartbeat") {
    await writeAudit({
      actorType: "system",
      source: "smart_scm",
      action: `smart_scm.print.${action}`,
      details: {
        printJobId: Number(job.id),
        yardCode: printer.yard_code,
        agentId: printer.agent_id,
        error: next.error,
        diagnostics
      }
    });
  }
  return publicJob({ ...result.rows[0], yard_code: printer.yard_code, printer_name: printer.printer_name });
}

export async function retrySmartScmPrintJob(jobId, operatorId = null) {
  const current = await query(
    `SELECT j.document_type, j.status AS job_status, p.*
       FROM scm_print_jobs j
       JOIN scm_yard_printers p ON p.location_id = j.location_id
      WHERE j.id = $1`,
    [Number(jobId)]
  );
  const reroutedPrinterTargets = current.rowCount
    && ["failed", "uncertain"].includes(current.rows[0].job_status)
    && TRANSFER_ORDER_DOCUMENT_TYPES.has(current.rows[0].document_type)
    ? routedPrinterTargets(current.rows[0], current.rows[0].document_type)
    : null;
  if (reroutedPrinterTargets && reroutedPrinterTargets.length !== 2) {
    throw Object.assign(new Error(`${current.rows[0].yard_code} requires two different printers assigned to TO printing before requeueing this job.`), { status: 409 });
  }
  const result = await query(
    `UPDATE scm_print_jobs
        SET status = 'queued', lease_token_hash = NULL, lease_expires_at = NULL, leased_by = NULL,
            started_at = NULL, printed_at = NULL, last_error = NULL, agent_diagnostics = '{}'::jsonb,
            printer_names = COALESCE($2::jsonb, printer_names),
            printer_targets = COALESCE($3::jsonb, printer_targets),
            updated_at = now()
      WHERE id = $1 AND status IN ('failed', 'uncertain')
      RETURNING *`,
    [
      Number(jobId),
      reroutedPrinterTargets ? JSON.stringify(reroutedPrinterTargets.map((target) => target.printerName)) : null,
      reroutedPrinterTargets ? JSON.stringify(reroutedPrinterTargets) : null
    ]
  );
  if (!result.rowCount) throw Object.assign(new Error("Only failed or uncertain print jobs can be requeued."), { status: 409 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.print.retry",
    details: { printJobId: Number(jobId) }
  });
  const printer = await query("SELECT yard_code, printer_name FROM scm_yard_printers WHERE location_id = $1", [result.rows[0].location_id]);
  return publicJob({ ...result.rows[0], ...printer.rows[0] });
}
