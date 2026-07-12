import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, withTransaction, closeDb } from "./db.js";
import { createPhotoUploadToken } from "./photo-upload.js";

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

const uploads = [];
const updates = [];
const skipped = [];

async function main() {
  await assertConfigured();
  await collectTextTargets();
  await collectJsonTargets();

  for (const upload of uploads) {
    upload.r2Ref = await uploadDataImage(upload);
  }

  await withTransaction(async () => {
    for (const update of updates) {
      await update.apply();
    }
  });

  const report = {
    migratedAt: new Date().toISOString(),
    uniqueUploads: uploads.length,
    updatedReferences: updates.length,
    skipped,
    uploads: uploads.map((item) => ({
      hash: item.hash,
      r2Ref: item.r2Ref,
      contentType: item.contentType,
      bytes: item.bytes.length,
      source: item.source
    }))
  };
  await fs.mkdir(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, `r2-photo-migration-${timestampKey()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: true,
    uniqueUploads: report.uniqueUploads,
    updatedReferences: report.updatedReferences,
    skipped: skipped.length,
    reportPath
  }, null, 2));
}

async function assertConfigured() {
  const ticket = createPhotoUploadToken({
    actor: { id: "migration", username: "migration", role: "admin" },
    source: "operator",
    recordType: "test-upload",
    metadata: { orderRef: "migration-config-check" },
    options: { ttlMinutes: 1, maxBytes: 1 }
  });
  if (!ticket.uploadUrl || !ticket.token) throw new Error("R2 upload token configuration is incomplete.");
}

async function collectTextTargets() {
  for (const target of TEXT_TARGETS) {
    if (!(await tableExists(target.table))) continue;
    const result = await query(`SELECT * FROM ${target.table} WHERE ${target.column} LIKE 'data:image/%' ORDER BY ${target.idColumn}`);
    for (const row of result.rows) {
      const r2Ref = enqueueDataImage(row[target.column], target, row, `${target.table}.${target.column}:${row[target.idColumn]}`);
      if (!r2Ref) continue;
      updates.push({
        source: `${target.table}.${target.column}:${row[target.idColumn]}`,
        async apply() {
          await query(
            `UPDATE ${target.table}
                SET ${target.column} = $1
              WHERE ${target.idColumn} = $2
                AND ${target.column} = $3`,
            [r2Ref(), row[target.idColumn], row[target.column]]
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
        WHERE ${target.column}::text LIKE '%data:image/%'
        ORDER BY ${target.idColumn}`
    );
    for (const row of result.rows) {
      const values = Array.isArray(row[target.column]) ? row[target.column] : [];
      let changed = false;
      const nextValues = values.map((value, index) => {
        if (!isDataImage(value)) return value;
        const r2Ref = enqueueDataImage(value, target, row, `${target.table}.${target.column}:${row[target.idColumn]}[${index}]`);
        if (!r2Ref) return value;
        changed = true;
        return r2Ref;
      });
      if (!changed) continue;
      updates.push({
        source: `${target.table}.${target.column}:${row[target.idColumn]}`,
        async apply() {
          const resolved = nextValues.map((value) => typeof value === "function" ? value() : value);
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

function enqueueDataImage(value, target, row, source) {
  if (!isDataImage(value)) return null;
  const parsed = parseDataUrl(value);
  if (!parsed) {
    skipped.push({ source, reason: "Invalid data URL" });
    return null;
  }
  const hash = crypto.createHash("sha256").update(parsed.bytes).digest("hex");
  const upload = {
    hash,
    bytes: parsed.bytes,
    contentType: parsed.contentType,
    target,
    row,
    source,
    r2Ref: ""
  };
  uploads.push(upload);
  return () => upload.r2Ref;
}

async function uploadDataImage(upload) {
  const ticket = createPhotoUploadToken({
    actor: upload.target.actor(upload.row),
    source: upload.target.source,
    recordType: upload.target.recordType(upload.row),
    metadata: upload.target.metadata(upload.row),
    options: {
      maxBytes: upload.bytes.length,
      ttlMinutes: 10
    }
  });
  const response = await fetch(ticket.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ticket.token}`,
      "Content-Type": upload.contentType,
      "Content-Length": String(upload.bytes.length),
      "X-File-Name": `${safeFileName(upload.source)}${extensionFromType(upload.contentType)}`
    },
    body: upload.bytes
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload?.key) {
    throw new Error(`R2 upload failed for ${upload.source}: ${response.status} ${text}`);
  }
  return `r2://${payload.key}`;
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  return {
    contentType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64")
  };
}

function isDataImage(value) {
  return String(value || "").startsWith("data:image/");
}

async function tableExists(table) {
  const result = await query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

function extensionFromType(contentType) {
  switch (contentType) {
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

function datePart(value) {
  if (!value) return "unknown-date";
  return new Date(value).toISOString().slice(0, 10);
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
