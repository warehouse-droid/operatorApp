import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";

function text(value) {
  return String(value ?? "").trim();
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
  return {
    locationId: Number(row.location_id),
    yardCode: row.yard_code,
    printerName: row.printer_name,
    agentId: row.agent_id,
    hasToken: Boolean(row.agent_token_hash),
    enabled: Boolean(row.enabled),
    status,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    settings: row.settings || {},
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
  };
}

function publicJob(row) {
  return {
    id: Number(row.id),
    jobKey: row.job_key,
    proposalId: row.proposal_id === null ? null : Number(row.proposal_id),
    locationId: Number(row.location_id),
    yardCode: row.yard_code,
    printerName: row.printer_name,
    documentType: row.document_type,
    documentName: row.document_name,
    documentSha256: row.document_sha256,
    sourceOrderId: row.source_order_id === null || row.source_order_id === undefined ? null : Number(row.source_order_id),
    sourceOrderRef: row.source_order_ref || "",
    lineLocationId: row.line_location_id === null || row.line_location_id === undefined ? null : Number(row.line_location_id),
    status: row.status,
    attempts: Number(row.attempts || 0),
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    printedAt: row.printed_at,
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
  const printerName = text(values.printerName ?? current.rows[0].printer_name);
  const enabled = values.enabled === undefined ? Boolean(current.rows[0].enabled) : Boolean(values.enabled);
  if (enabled && !printerName) throw Object.assign(new Error("Printer name is required before enabling this yard."), { status: 400 });
  const settings = values.settings && typeof values.settings === "object" ? values.settings : current.rows[0].settings || {};
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
    details: { locationId: id, yardCode: result.rows[0].yard_code, printerName, enabled, settings }
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
    `UPDATE scm_yard_printers SET status = 'online', last_seen_at = now(), last_error = NULL WHERE location_id = $1`,
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
  lineLocationId = null
}, operatorId = null) {
  const id = Number(locationId);
  const printer = await query("SELECT * FROM scm_yard_printers WHERE location_id = $1", [id]);
  if (!printer.rowCount) throw Object.assign(new Error("The source yard has no printer setup row."), { status: 409 });
  if (!printer.rows[0].enabled) throw Object.assign(new Error(`${printer.rows[0].yard_code} printer is disabled.`), { status: 409 });
  if (!printer.rows[0].agent_token_hash) throw Object.assign(new Error(`${printer.rows[0].yard_code} printer agent token has not been generated.`), { status: 409 });
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
         source_order_id, source_order_ref, line_location_id, queued_by_operator_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (job_key) DO UPDATE SET updated_at = scm_print_jobs.updated_at
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
        operatorId || null
      ]
    );
  } catch (error) {
    await fs.unlink(documentPath).catch(() => null);
    throw error;
  }
  if (result.rows[0].document_path !== documentPath) await fs.unlink(documentPath).catch(() => null);
  await writeAudit({
    actorType: operatorId ? "operator" : "system",
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
      sha256
    }
  });
  return publicJob({ ...result.rows[0], yard_code: printer.rows[0].yard_code, printer_name: printer.rows[0].printer_name });
}

export async function queueYardPrinterTest(locationId, operatorId = null) {
  const printer = await query("SELECT * FROM scm_yard_printers WHERE location_id = $1", [Number(locationId)]);
  if (!printer.rowCount) throw Object.assign(new Error("Yard printer was not found."), { status: 404 });
  const row = printer.rows[0];
  const pdf = createSimplePdf([
    "MBBS Smart SCM Printer Test",
    `Yard: ${row.yard_code}`,
    `Printer: ${row.printer_name || "Not configured"}`,
    `Agent: ${row.agent_id}`,
    `Queued: ${new Date().toISOString()}`
  ]);
  return queueSmartScmPrintJob({
    locationId: row.location_id,
    documentType: "test",
    documentName: `MBBS-${row.yard_code}-printer-test.pdf`,
    documentBuffer: pdf,
    jobKey: `printer-test:${row.location_id}:${Date.now()}`
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

export async function leaseYardPrintJob(agentToken, agentId = "") {
  const printer = await authenticateYardPrinterAgent(agentToken, agentId);
  if (!printer) throw Object.assign(new Error("Valid enabled printer-agent credentials are required."), { status: 401 });
  await reclaimExpiredPrintJobs(printer.location_id);
  return withTransaction(async () => {
    const selected = await query(
      `SELECT * FROM scm_print_jobs
        WHERE location_id = $1 AND status = 'queued'
        ORDER BY queued_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [printer.location_id]
    );
    if (!selected.rowCount) return { job: null, pollAfterSeconds: 10 };
    const leaseToken = crypto.randomBytes(24).toString("base64url");
    const updated = await query(
      `UPDATE scm_print_jobs
          SET status = 'leased', attempts = attempts + 1,
              lease_token_hash = $2, lease_expires_at = now() + interval '5 minutes',
              leased_by = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [selected.rows[0].id, hashToken(leaseToken), printer.agent_id]
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
    completed: { status: "printed", error: null, printed: true },
    failed: { status: "failed", error: text(details.error) || "Printer agent reported a failure.", printed: false },
    uncertain: { status: "uncertain", error: text(details.error) || "Printer result is uncertain.", printed: false }
  };
  const next = actions[action];
  if (!next) throw Object.assign(new Error("Invalid print-agent action."), { status: 400 });
  const result = await query(
    `UPDATE scm_print_jobs
        SET status = $2,
            started_at = CASE WHEN $2 IN ('printing', 'printed') THEN COALESCE(started_at, now()) ELSE started_at END,
            printed_at = CASE WHEN $3 THEN now() ELSE printed_at END,
            last_error = $4,
            lease_expires_at = CASE WHEN $2 = 'printing' THEN now() + interval '10 minutes' ELSE NULL END,
            lease_token_hash = CASE WHEN $2 = 'printing' THEN lease_token_hash ELSE NULL END,
            leased_by = CASE WHEN $2 = 'printing' THEN leased_by ELSE NULL END,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [job.id, next.status, next.printed, next.error]
  );
  if (next.status === "failed") {
    await query("UPDATE scm_yard_printers SET status = 'error', last_error = $2 WHERE location_id = $1", [printer.location_id, next.error]);
  }
  await writeAudit({
    actorType: "system",
    source: "smart_scm",
    action: `smart_scm.print.${action}`,
    details: { printJobId: Number(job.id), yardCode: printer.yard_code, agentId: printer.agent_id, error: next.error }
  });
  return publicJob({ ...result.rows[0], yard_code: printer.yard_code, printer_name: printer.printer_name });
}

export async function retrySmartScmPrintJob(jobId, operatorId = null) {
  const result = await query(
    `UPDATE scm_print_jobs
        SET status = 'queued', lease_token_hash = NULL, lease_expires_at = NULL, leased_by = NULL,
            started_at = NULL, printed_at = NULL, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('failed', 'uncertain')
      RETURNING *`,
    [Number(jobId)]
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
