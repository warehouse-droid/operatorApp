import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "./db.js";
import { createPhotoReadToken, createPhotoUploadToken, normalizeR2Key } from "./photo-upload.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(dirname, "..");
const dataDir = path.join(serverRoot, "data");

const TEXT_TARGETS = [
  {
    table: "operator_load_records",
    column: "photo_data_url",
    idColumn: "id",
    source: "operator",
    recordType(row) {
      return row.load_type === "customer_pickup_load" ? "operator-customer-pickup-photo" : "operator-load-photo";
    },
    metadata(row) {
      return {
        orderType: row.order_family,
        orderId: row.order_id,
        orderRef: row.order_ref,
        lineId: row.source_record_id
      };
    },
    actor(row) {
      return { id: row.operator_id || "migration", username: "migration", role: "operator", operatorId: row.operator_id || "" };
    }
  },
  {
    table: "customer_pickup_load_records",
    column: "photo_data_url",
    idColumn: "id",
    source: "operator",
    recordType: () => "operator-customer-pickup-photo",
    metadata(row) {
      return {
        orderType: "sales_order",
        orderId: row.order_id,
        orderRef: row.order_ref || row.order_id,
        lineId: row.id
      };
    },
    actor(row) {
      return { id: row.operator_id || "migration", username: "migration", role: "operator", operatorId: row.operator_id || "" };
    }
  },
  {
    table: "delivery_fulfillment_records",
    column: "photo_data_url",
    idColumn: "id",
    source: "operator",
    recordType: () => "operator-load-photo",
    metadata(row) {
      return {
        orderType: "sales_order",
        orderId: row.order_id,
        orderRef: row.order_ref || row.order_id,
        lineId: row.id
      };
    },
    actor(row) {
      return { id: row.operator_id || "migration", username: "migration", role: "operator", operatorId: row.operator_id || "" };
    }
  }
];

const JSONB_TARGETS = [
  {
    table: "receiving_receipt_records",
    column: "photo_data_urls",
    idColumn: "id",
    source: "operator",
    recordType: () => "operator-receiving-photo",
    metadata(row) {
      return {
        orderType: "receiving",
        orderId: row.order_id,
        orderRef: row.order_ref || row.order_id
      };
    },
    actor(row) {
      return { id: row.operator_id || "migration", username: "migration", role: "operator", operatorId: row.operator_id || "" };
    }
  },
  {
    table: "local_co_receipt_records",
    column: "photo_data_urls",
    idColumn: "id",
    source: "operator",
    recordType: () => "operator-co-receiving-photo",
    metadata(row) {
      return {
        orderType: "consolidation_order",
        orderId: row.co_id,
        orderRef: row.co_ref || row.co_id
      };
    },
    actor(row) {
      return { id: row.operator_id || "migration", username: "migration", role: "operator", operatorId: row.operator_id || "" };
    }
  },
  {
    table: "driver_day_records",
    column: "pre_dvir_photo_data_urls",
    idColumn: "id",
    source: "driver",
    recordType: () => "driver-dvir-pre-photo",
    metadata(row) {
      return {
        planId: row.plan_id,
        orderRef: `${row.driver_login || "driver"}-${datePart(row.plan_date)}`,
        dvirType: "pre"
      };
    },
    actor(row) {
      return { id: row.driver_login || "migration", login: row.driver_login || "migration", driverId: row.driver_login || "", role: "driver" };
    }
  },
  {
    table: "driver_day_records",
    column: "post_dvir_photo_data_urls",
    idColumn: "id",
    source: "driver",
    recordType: () => "driver-dvir-post-photo",
    metadata(row) {
      return {
        planId: row.plan_id,
        orderRef: `${row.driver_login || "driver"}-${datePart(row.plan_date)}`,
        dvirType: "post"
      };
    },
    actor(row) {
      return { id: row.driver_login || "migration", login: row.driver_login || "migration", driverId: row.driver_login || "", role: "driver" };
    }
  },
  {
    table: "driver_job_records",
    column: "photo_data_urls",
    idColumn: "id",
    source: "driver",
    recordType(row) {
      if (row.stop_type === "pickup") return "driver-pickup-photo";
      if (row.stop_type === "dropoff") return "driver-dropoff-photo";
      return "driver-stop-photo";
    },
    metadata(row) {
      return {
        planId: row.plan_id,
        loadId: row.load_id,
        jobId: row.job_id,
        stopId: row.stop_id,
        orderRef: Array.isArray(row.order_refs) ? row.order_refs.join("-") : row.job_id
      };
    },
    actor(row) {
      return { id: row.driver_login || "migration", login: row.driver_login || "migration", driverId: row.driver_login || "", role: "driver" };
    }
  }
];

const entries = [];
const updates = [];

async function main() {
  await collectTextTargets();
  await collectJsonTargets();

  for (const entry of entries) {
    const downloaded = await downloadR2Reference(entry.oldRef);
    entry.hash = crypto.createHash("sha256").update(downloaded.bytes).digest("hex");
    entry.contentType = downloaded.contentType;
    entry.bytes = downloaded.bytes.length;
    entry.newRef = await uploadR2Copy(entry, downloaded);
  }

  await withTransaction(async () => {
    for (const update of updates) await update.apply();
  });

  const report = {
    repairedAt: new Date().toISOString(),
    uploadedReferences: entries.length,
    oldRefs: [...new Set(entries.map((entry) => entry.oldRef))],
    entries: entries.map((entry) => ({
      source: entry.sourceLabel,
      oldRef: entry.oldRef,
      newRef: entry.newRef,
      contentType: entry.contentType,
      bytes: entry.bytes,
      hash: entry.hash
    }))
  };
  await fs.mkdir(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, `r2-photo-rededup-repair-${timestampKey()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: true,
    uploadedReferences: entries.length,
    replacedDbGroups: updates.length,
    oldUniqueRefs: report.oldRefs.length,
    reportPath
  }, null, 2));
}

async function collectTextTargets() {
  for (const target of TEXT_TARGETS) {
    if (!(await tableExists(target.table))) continue;
    const result = await query(`SELECT * FROM ${target.table} WHERE ${target.column} LIKE 'r2://%' ORDER BY ${target.idColumn}`);
    for (const row of result.rows) {
      const entry = addEntry({
        target,
        row,
        oldRef: row[target.column],
        sourceLabel: `${target.table}.${target.column}:${row[target.idColumn]}`
      });
      updates.push({
        async apply() {
          await query(
            `UPDATE ${target.table}
                SET ${target.column} = $1
              WHERE ${target.idColumn} = $2
                AND ${target.column} = $3`,
            [entry.newRef, row[target.idColumn], entry.oldRef]
          );
        }
      });
    }
  }
}

async function collectJsonTargets() {
  for (const target of JSONB_TARGETS) {
    if (!(await tableExists(target.table))) continue;
    const result = await query(
      `SELECT * FROM ${target.table}
        WHERE ${target.column}::text LIKE '%r2://%'
        ORDER BY ${target.idColumn}`
    );
    for (const row of result.rows) {
      const values = Array.isArray(row[target.column]) ? row[target.column] : [];
      let changed = false;
      const nextValues = values.map((value, index) => {
        if (!String(value || "").startsWith("r2://")) return value;
        changed = true;
        return addEntry({
          target,
          row,
          oldRef: value,
          sourceLabel: `${target.table}.${target.column}:${row[target.idColumn]}[${index}]`
        });
      });
      if (!changed) continue;
      updates.push({
        async apply() {
          const resolved = nextValues.map((value) => typeof value === "object" && value?.newRef ? value.newRef : value);
          await query(
            `UPDATE ${target.table}
                SET ${target.column} = $1::jsonb
              WHERE ${target.idColumn} = $2
                AND ${target.column} = $3::jsonb`,
            [JSON.stringify(resolved), row[target.idColumn], JSON.stringify(values)]
          );
        }
      });
    }
  }
}

function addEntry({ target, row, oldRef, sourceLabel }) {
  const entry = {
    target,
    row,
    oldRef,
    sourceLabel,
    newRef: "",
    contentType: "",
    bytes: 0,
    hash: ""
  };
  entries.push(entry);
  return entry;
}

async function downloadR2Reference(ref) {
  const readTicket = createPhotoReadToken({
    actor: { id: "migration", username: "migration", role: "admin" },
    key: normalizeR2Key(ref),
    options: { ttlMinutes: 10 }
  });
  const response = await fetch(readTicket.objectUrl, {
    headers: { Authorization: `Bearer ${readTicket.token}` }
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Failed to read ${ref}: ${response.status} ${bytes.toString("utf8")}`);
  }
  return {
    bytes,
    contentType: response.headers.get("content-type") || "application/octet-stream"
  };
}

async function uploadR2Copy(entry, downloaded) {
  const ticket = createPhotoUploadToken({
    actor: entry.target.actor(entry.row),
    source: entry.target.source,
    recordType: entry.target.recordType(entry.row),
    metadata: entry.target.metadata(entry.row),
    options: {
      maxBytes: downloaded.bytes.length,
      ttlMinutes: 10
    }
  });
  const response = await fetch(ticket.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ticket.token}`,
      "Content-Type": downloaded.contentType,
      "Content-Length": String(downloaded.bytes.length),
      "X-File-Name": `${safeFileName(entry.sourceLabel)}${extensionFromType(downloaded.contentType)}`
    },
    body: downloaded.bytes
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.key) {
    throw new Error(`R2 re-upload failed for ${entry.sourceLabel}: ${response.status} ${text}`);
  }
  return `r2://${payload.key}`;
}

async function tableExists(table) {
  const result = await query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

function datePart(value) {
  if (!value) return "unknown-date";
  return new Date(value).toISOString().slice(0, 10);
}

function extensionFromType(contentType) {
  switch (String(contentType || "").toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/heic": return ".heic";
    case "image/heif": return ".heif";
    default: return ".jpg";
  }
}

function safeFileName(value) {
  return String(value || "photo")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "photo";
}

function timestampKey() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
