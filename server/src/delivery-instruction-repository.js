import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";
import {
  assertDeliveryInstructionRevision,
  deliveryInstructionEditBlock,
  deliveryInstructionUploadReferenceMatches,
  deriveMemoDeliveryInstruction,
  normalizeDeliveryInstructionMedia,
  normalizeDeliveryInstructionText
} from "./delivery-instruction-domain.js";
import { salesStoreLocationIdSql } from "./sales-store.js";

const EFFECTIVE_ORDERING_LOCATION_SQL = `COALESCE(
  so.order_location_id,
  ${salesStoreLocationIdSql("so.tranid")}
)`;

function repositoryError(message, status = 400, code = "DELIVERY_INSTRUCTION_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function normalizeSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (!new Set(["sales", "dispatch"]).has(source)) {
    throw repositoryError("A valid delivery-instruction editor source is required.");
  }
  return source;
}

function normalizedAuthorizedYards(value) {
  if (value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map(Number).filter((entry) => Number.isInteger(entry) && entry > 0))];
}

function assertOrderYardAccess(row, authorizedOrderingLocationIds) {
  const authorized = normalizedAuthorizedYards(authorizedOrderingLocationIds);
  if (authorized === null) return;
  if (!authorized.includes(Number(row.ordering_location_id))) {
    throw repositoryError("This Sales Order belongs to a yard you cannot access.", 403, "DELIVERY_INSTRUCTION_FORBIDDEN");
  }
}

function terminalOrder(row) {
  const status = `${row.status || ""} ${row.status_text || ""}`.trim().toLowerCase();
  return row.netsuite_active === false || /\b(?:closed|cancelled|canceled|voided|rejected)\b/u.test(status);
}

function automaticInstruction(row) {
  const details = row.dispatch_instruction_details;
  if (
    Number(row.dispatch_instruction_parse_version) >= 2
    && details
    && typeof details === "object"
    && typeof details.text === "string"
    && Array.isArray(details.phones)
  ) {
    return {
      text: details.text,
      phones: details.phones
        .filter((phone) => phone && typeof phone === "object")
        .map((phone) => ({ display: String(phone.display || ""), href: String(phone.href || "") }))
        .filter((phone) => phone.display && phone.href),
      fallbackUsed: Boolean(details.fallbackUsed),
      source: String(details.source || "parsed-memo")
    };
  }
  return deriveMemoDeliveryInstruction(row.memo);
}

function publicMedia(row) {
  return {
    id: String(row.id),
    mediaKind: row.media_kind,
    mimeType: row.mime_type,
    fileName: row.original_file_name,
    byteSize: Number(row.byte_size),
    position: Number(row.position),
    createdAt: row.created_at,
    contentUrl: `/api/delivery-instruction-media/${encodeURIComponent(row.id)}/content`,
    onlineOnly: row.media_kind === "video"
  };
}

function publicOrder(row, media = []) {
  const terminal = terminalOrder(row);
  const dropoffCompleted = Boolean(row.dropoff_completed);
  const lockReason = deliveryInstructionEditBlock({ terminal, dropoffCompleted });
  return {
    orderId: Number(row.order_id),
    orderRef: row.order_ref || `SO-${row.order_id}`,
    orderDate: row.order_date,
    customer: row.customer || "",
    status: row.status_text || row.status || "",
    orderingLocationId: row.ordering_location_id === null ? null : Number(row.ordering_location_id),
    dispatchAddress: row.dispatch_address || "",
    automatic: automaticInstruction(row),
    additionalText: row.additional_text || "",
    revision: Number(row.revision || 0),
    media: media.map(publicMedia),
    dropoffCompleted,
    terminal,
    editable: !lockReason,
    lockReason: lockReason || "",
    updatedAt: row.instruction_updated_at || null,
    updatedBy: row.instruction_updated_by || ""
  };
}

const ORDER_SELECT = `
  so.netsuite_id AS order_id,
  so.tranid AS order_ref,
  so.trandate AS order_date,
  so.customer,
  so.status,
  so.status_text,
  so.memo,
  so.dispatch_address,
  so.netsuite_active,
  so.dispatch_instruction_details,
  so.dispatch_instruction_parse_version,
  ${EFFECTIVE_ORDERING_LOCATION_SQL} AS ordering_location_id,
  COALESCE(instruction.additional_text, '') AS additional_text,
  COALESCE(instruction.revision, 0) AS revision,
  instruction.updated_at AS instruction_updated_at,
  instruction.updated_by AS instruction_updated_by,
  EXISTS (
    SELECT 1
      FROM driver_job_records job
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(COALESCE(job.order_refs, '[]'::jsonb)) = 'array'
             THEN COALESCE(job.order_refs, '[]'::jsonb)
             ELSE '[]'::jsonb END
      ) completed_ref(value)
     WHERE lower(COALESCE(job.status, '')) = 'complete'
       AND lower(COALESCE(job.stop_type, '')) = 'dropoff'
       AND (
         upper(btrim(completed_ref.value)) = upper(btrim(COALESCE(so.tranid, '')))
         OR EXISTS (
           SELECT 1
             FROM dispatch_scm_so_splits family_split
            WHERE family_split.source_so_id = so.netsuite_id
              AND upper(btrim(completed_ref.value)) = upper(btrim(family_split.split_so_ref))
         )
       )
  ) AS dropoff_completed`;

async function mediaForOrderIds(orderIds = []) {
  const ids = [...new Set(orderIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT id, sales_order_id, media_kind, mime_type, original_file_name,
            byte_size, position, created_at
       FROM sales_order_delivery_instruction_media
      WHERE sales_order_id = ANY($1::bigint[])
        AND deleted_at IS NULL
      ORDER BY sales_order_id, position, created_at, id`,
    [ids]
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const key = Number(row.sales_order_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

export async function listDeliveryInstructionOrders({
  search = "",
  authorizedOrderingLocationIds,
  limit = 100
} = {}) {
  const authorized = normalizedAuthorizedYards(authorizedOrderingLocationIds);
  if (authorized && !authorized.length) return [];
  const term = String(search || "").trim().toLowerCase();
  const max = Math.min(200, Math.max(1, Number(limit) || 100));
  const result = await query(
    `SELECT ${ORDER_SELECT}
       FROM sales_orders so
       LEFT JOIN sales_order_delivery_instructions instruction
         ON instruction.sales_order_id = so.netsuite_id
      WHERE lower(btrim(COALESCE(so.sales_order_type, ''))) = 'delivery'
        AND NOT EXISTS (
          SELECT 1
            FROM dispatch_scm_so_splits split
           WHERE split.split_so_id = so.netsuite_id
        )
        AND ($1::bigint[] IS NULL OR ${EFFECTIVE_ORDERING_LOCATION_SQL} = ANY($1::bigint[]))
        AND (
          $2 = ''
          OR lower(concat_ws(' ', so.tranid, so.customer, so.dispatch_address, so.memo,
                              so.status_text, instruction.additional_text)) LIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1
              FROM dispatch_scm_so_splits family_split
             WHERE family_split.source_so_id = so.netsuite_id
               AND lower(family_split.split_so_ref) LIKE '%' || $2 || '%'
          )
        )
      ORDER BY COALESCE(instruction.updated_at, so.trandate::timestamptz, so.synced_at) DESC NULLS LAST,
               so.netsuite_id DESC
      LIMIT $3`,
    [authorized, term, max]
  );
  const media = await mediaForOrderIds(result.rows.map((row) => row.order_id));
  return result.rows.map((row) => publicOrder(row, media.get(Number(row.order_id)) || []));
}

async function findOrderRow(identifier) {
  const raw = String(identifier ?? "").trim();
  if (!raw) throw repositoryError("Sales Order is required.");
  const numericId = /^-?\d+$/u.test(raw) ? raw : null;
  const result = await query(
    `WITH requested_order AS (
       SELECT requested.netsuite_id,
              COALESCE(split.source_so_id, requested.netsuite_id) AS instruction_order_id
         FROM sales_orders requested
         LEFT JOIN dispatch_scm_so_splits split
           ON split.split_so_id = requested.netsuite_id
        WHERE lower(btrim(COALESCE(requested.sales_order_type, ''))) = 'delivery'
          AND (($1::bigint IS NOT NULL AND requested.netsuite_id = $1::bigint)
               OR upper(btrim(COALESCE(requested.tranid, ''))) = upper($2))
        ORDER BY CASE WHEN $1::bigint IS NOT NULL AND requested.netsuite_id = $1::bigint THEN 0 ELSE 1 END
        LIMIT 1
     )
     SELECT ${ORDER_SELECT}
       FROM requested_order requested
       JOIN sales_orders so
         ON so.netsuite_id = requested.instruction_order_id
       LEFT JOIN sales_order_delivery_instructions instruction
         ON instruction.sales_order_id = so.netsuite_id
      LIMIT 1`,
    [numericId, raw]
  );
  if (!result.rowCount) throw repositoryError("Delivery Sales Order was not found.", 404, "DELIVERY_INSTRUCTION_NOT_FOUND");
  return result.rows[0];
}

export async function getDeliveryInstruction(identifier, { authorizedOrderingLocationIds } = {}) {
  const row = await findOrderRow(identifier);
  assertOrderYardAccess(row, authorizedOrderingLocationIds);
  const media = await mediaForOrderIds([row.order_id]);
  return publicOrder(row, media.get(Number(row.order_id)) || []);
}

async function lockOrderState(identifier, context = {}) {
  const initial = await findOrderRow(identifier);
  assertOrderYardAccess(initial, context.authorizedOrderingLocationIds);
  await query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`delivery-instruction:${String(initial.order_ref || "").trim().toUpperCase()}`]
  );
  await query(`SELECT netsuite_id FROM sales_orders WHERE netsuite_id = $1 FOR UPDATE`, [initial.order_id]);
  const current = await findOrderRow(initial.order_id);
  assertOrderYardAccess(current, context.authorizedOrderingLocationIds);
  await query(
    `SELECT sales_order_id
       FROM sales_order_delivery_instructions
      WHERE sales_order_id = $1
      FOR UPDATE`,
    [current.order_id]
  );
  return current;
}

function assertEditable(row) {
  const reason = deliveryInstructionEditBlock({
    terminal: terminalOrder(row),
    dropoffCompleted: Boolean(row.dropoff_completed)
  });
  if (reason) throw repositoryError(reason, 409, "DELIVERY_INSTRUCTION_READ_ONLY");
}

async function incrementRevision(row, { operatorId, source, additionalText } = {}) {
  const hasText = additionalText !== undefined;
  const result = await query(
    `INSERT INTO sales_order_delivery_instructions (
       sales_order_id, additional_text, revision, created_by, created_source,
       updated_by, updated_source, created_at, updated_at
     ) VALUES ($1,$2,1,$3,$4,$3,$4,now(),now())
     ON CONFLICT (sales_order_id) DO UPDATE SET
       additional_text = CASE WHEN $5::boolean
                              THEN EXCLUDED.additional_text
                              ELSE sales_order_delivery_instructions.additional_text END,
       revision = sales_order_delivery_instructions.revision + 1,
       updated_by = EXCLUDED.updated_by,
       updated_source = EXCLUDED.updated_source,
       updated_at = now()
     RETURNING revision`,
    [row.order_id, hasText ? additionalText : "", operatorId || null, source, hasText]
  );
  return Number(result.rows[0].revision);
}

export async function saveDeliveryInstructionText(identifier, input = {}, context = {}) {
  const source = normalizeSource(context.source);
  const additionalText = normalizeDeliveryInstructionText(input.additionalText);
  return withTransaction(async () => {
    const row = await lockOrderState(identifier, context);
    assertEditable(row);
    assertDeliveryInstructionRevision(input.expectedRevision, row.revision);
    await incrementRevision(row, { operatorId: context.operatorId, source, additionalText });
    return getDeliveryInstruction(row.order_id, {
      authorizedOrderingLocationIds: context.authorizedOrderingLocationIds
    });
  });
}

export async function issueDeliveryInstructionMediaUpload(identifier, input = {}, context = {}) {
  const source = normalizeSource(context.source);
  const normalized = normalizeDeliveryInstructionMedia(input);
  const replaceMediaId = String(input.replaceMediaId || "").trim().toLowerCase();
  return withTransaction(async () => {
    const row = await lockOrderState(identifier, context);
    assertEditable(row);
    assertDeliveryInstructionRevision(input.expectedRevision, row.revision);
    let replacement = null;
    if (replaceMediaId) {
      const replacementResult = await query(
        `SELECT id, position
           FROM sales_order_delivery_instruction_media
          WHERE id = $1::uuid
            AND sales_order_id = $2
            AND deleted_at IS NULL
          FOR UPDATE`,
        [replaceMediaId, row.order_id]
      ).catch(() => ({ rows: [], rowCount: 0 }));
      if (!replacementResult.rowCount) {
        throw repositoryError("The delivery-instruction file to replace was not found.", 404, "DELIVERY_INSTRUCTION_MEDIA_NOT_FOUND");
      }
      replacement = replacementResult.rows[0];
    }
    const countResult = await query(
      `SELECT (
         SELECT COUNT(*)::integer
           FROM sales_order_delivery_instruction_media
          WHERE sales_order_id = $1 AND deleted_at IS NULL
       ) + (
         SELECT COUNT(*)::integer
           FROM sales_order_delivery_instruction_upload_tickets
          WHERE sales_order_id = $1
            AND consumed_at IS NULL
            AND expires_at > now()
            AND replacement_media_id IS NULL
       ) AS count`,
      [row.order_id]
    );
    normalizeDeliveryInstructionMedia(input, {
      activeCount: Number(countResult.rows[0].count) - (replacement ? 1 : 0)
    });
    const uploadId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await query(
      `INSERT INTO sales_order_delivery_instruction_upload_tickets (
         id, sales_order_id, replacement_media_id, expected_revision, mime_type,
         original_file_name, byte_size, issued_by, issued_source, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        uploadId,
        row.order_id,
        replacement?.id || null,
        Number(input.expectedRevision),
        normalized.mimeType,
        normalized.fileName,
        normalized.byteSize,
        context.operatorId || null,
        source,
        expiresAt
      ]
    );
    return {
      uploadId,
      expiresAt: expiresAt.toISOString(),
      orderId: Number(row.order_id),
      orderRef: row.order_ref,
      replaceMediaId: replacement ? String(replacement.id) : null,
      ...normalized
    };
  });
}

export async function registerDeliveryInstructionMedia(identifier, input = {}, context = {}) {
  const source = normalizeSource(context.source);
  const uploadId = String(input.uploadId || "").trim().toLowerCase();
  return withTransaction(async () => {
    const row = await lockOrderState(identifier, context);
    const existing = await query(
      `SELECT id, sales_order_id, object_reference, mime_type, original_file_name, byte_size, deleted_at
         FROM sales_order_delivery_instruction_media
        WHERE id = $1::uuid`,
      [uploadId]
    ).catch(() => ({ rows: [], rowCount: 0 }));
    if (existing.rowCount) {
      const stored = existing.rows[0];
      const exactReplay = Number(stored.sales_order_id) === Number(row.order_id)
        && !stored.deleted_at
        && stored.object_reference === String(input.objectReference || "")
        && stored.mime_type === String(input.mimeType || "").trim().toLowerCase()
        && stored.original_file_name === String(input.fileName || "").trim()
        && Number(stored.byte_size) === Number(input.byteSize);
      if (!exactReplay) throw repositoryError("This upload identifier is already registered.", 409, "DELIVERY_INSTRUCTION_UPLOAD_REPLAY");
      const detail = await getDeliveryInstruction(row.order_id, {
        authorizedOrderingLocationIds: context.authorizedOrderingLocationIds
      });
      return { ...detail, mediaMutation: { type: "replay", mediaId: uploadId } };
    }

    assertEditable(row);
    const ticketResult = await query(
      `SELECT *
         FROM sales_order_delivery_instruction_upload_tickets
        WHERE id = $1::uuid
        FOR UPDATE`,
      [uploadId]
    ).catch(() => ({ rows: [], rowCount: 0 }));
    if (!ticketResult.rowCount) {
      throw repositoryError("The delivery-instruction upload ticket is invalid.", 400, "DELIVERY_INSTRUCTION_UPLOAD_TICKET");
    }
    const ticket = ticketResult.rows[0];
    if (
      Number(ticket.sales_order_id) !== Number(row.order_id)
      || ticket.consumed_at
      || new Date(ticket.expires_at).getTime() <= Date.now()
      || ticket.issued_source !== source
      || String(ticket.issued_by || "") !== String(context.operatorId || "")
      || Number(ticket.expected_revision) !== Number(input.expectedRevision)
    ) {
      throw repositoryError("The delivery-instruction upload ticket is expired or does not match this edit.", 409, "DELIVERY_INSTRUCTION_UPLOAD_TICKET");
    }
    const countResult = await query(
      `SELECT COUNT(*)::integer AS count, COALESCE(MAX(position), 0)::integer AS max_position
         FROM sales_order_delivery_instruction_media
        WHERE sales_order_id = $1 AND deleted_at IS NULL`,
      [row.order_id]
    );
    let replacement = null;
    if (ticket.replacement_media_id) {
      const replacementResult = await query(
        `SELECT id, position
           FROM sales_order_delivery_instruction_media
          WHERE id = $1
            AND sales_order_id = $2
            AND deleted_at IS NULL
          FOR UPDATE`,
        [ticket.replacement_media_id, row.order_id]
      );
      if (!replacementResult.rowCount) {
        throw repositoryError("The delivery-instruction file being replaced changed in another session.", 409, "DELIVERY_INSTRUCTION_UPLOAD_TICKET");
      }
      replacement = replacementResult.rows[0];
    }
    const normalized = normalizeDeliveryInstructionMedia(input, {
      activeCount: Number(countResult.rows[0].count) - (replacement ? 1 : 0)
    });
    if (
      normalized.mimeType !== ticket.mime_type
      || normalized.fileName !== ticket.original_file_name
      || normalized.byteSize !== Number(ticket.byte_size)
    ) {
      throw repositoryError("Uploaded media does not match its issued ticket.", 400, "DELIVERY_INSTRUCTION_UPLOAD_MISMATCH");
    }
    if (!deliveryInstructionUploadReferenceMatches(input.objectReference, uploadId)) {
      throw repositoryError("Uploaded media reference does not match its issued ticket.", 400, "DELIVERY_INSTRUCTION_UPLOAD_REFERENCE");
    }
    const revision = await incrementRevision(row, { operatorId: context.operatorId, source });
    if (replacement) {
      await query(
        `UPDATE sales_order_delivery_instruction_media
            SET deleted_at = now(), deleted_by = $2, deleted_source = $3,
                instruction_revision = $4
          WHERE id = $1`,
        [replacement.id, context.operatorId || null, source, revision]
      );
    }
    await query(
      `INSERT INTO sales_order_delivery_instruction_media (
         id, sales_order_id, object_reference, media_kind, mime_type,
         original_file_name, byte_size, position, instruction_revision,
         uploaded_by, uploaded_source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        uploadId,
        row.order_id,
        String(input.objectReference || ""),
        normalized.mediaKind,
        normalized.mimeType,
        normalized.fileName,
        normalized.byteSize,
        replacement ? Number(replacement.position) : Number(countResult.rows[0].max_position) + 1,
        revision,
        context.operatorId || null,
        source
      ]
    );
    await query(
      `UPDATE sales_order_delivery_instruction_upload_tickets
          SET consumed_at = now()
        WHERE id = $1`,
      [uploadId]
    );
    const detail = await getDeliveryInstruction(row.order_id, {
      authorizedOrderingLocationIds: context.authorizedOrderingLocationIds
    });
    return {
      ...detail,
      mediaMutation: replacement
        ? { type: "replaced", mediaId: uploadId, replacedMediaId: String(replacement.id) }
        : { type: "added", mediaId: uploadId }
    };
  });
}

export async function removeDeliveryInstructionMedia(identifier, mediaId, input = {}, context = {}) {
  const source = normalizeSource(context.source);
  return withTransaction(async () => {
    const row = await lockOrderState(identifier, context);
    assertEditable(row);
    assertDeliveryInstructionRevision(input.expectedRevision, row.revision);
    const media = await query(
      `SELECT id
         FROM sales_order_delivery_instruction_media
        WHERE id = $1::uuid AND sales_order_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [String(mediaId || "").trim(), row.order_id]
    ).catch(() => ({ rows: [], rowCount: 0 }));
    if (!media.rowCount) throw repositoryError("Delivery-instruction media was not found.", 404, "DELIVERY_INSTRUCTION_MEDIA_NOT_FOUND");
    const revision = await incrementRevision(row, { operatorId: context.operatorId, source });
    await query(
      `UPDATE sales_order_delivery_instruction_media
          SET deleted_at = now(), deleted_by = $2, deleted_source = $3,
              instruction_revision = $4
        WHERE id = $1`,
      [media.rows[0].id, context.operatorId || null, source, revision]
    );
    return getDeliveryInstruction(row.order_id, {
      authorizedOrderingLocationIds: context.authorizedOrderingLocationIds
    });
  });
}

export async function getDeliveryInstructionMedia(mediaId) {
  const result = await query(
    `SELECT media.id, media.sales_order_id, media.object_reference, media.media_kind,
            media.mime_type, media.original_file_name, media.byte_size, media.position,
            media.created_at, so.tranid AS order_ref,
            ${EFFECTIVE_ORDERING_LOCATION_SQL} AS ordering_location_id
       FROM sales_order_delivery_instruction_media media
       JOIN sales_orders so ON so.netsuite_id = media.sales_order_id
      WHERE media.id = $1::uuid AND media.deleted_at IS NULL`,
    [String(mediaId || "").trim()]
  ).catch(() => ({ rows: [], rowCount: 0 }));
  if (!result.rowCount) throw repositoryError("Delivery-instruction media was not found.", 404, "DELIVERY_INSTRUCTION_MEDIA_NOT_FOUND");
  const row = result.rows[0];
  return {
    ...publicMedia(row),
    orderId: Number(row.sales_order_id),
    orderRef: row.order_ref,
    orderingLocationId: row.ordering_location_id === null ? null : Number(row.ordering_location_id),
    objectReference: row.object_reference
  };
}

export async function getDeliveryInstructionsForDriverOrderIds(orderIds = []) {
  const ids = [...new Set(orderIds.map(Number).filter((id) => Number.isSafeInteger(id) && id !== 0))];
  if (!ids.length) return {};
  const result = await query(
    `WITH requested_orders AS (
       SELECT requested_id.value AS requested_order_id,
              requested.tranid AS requested_order_ref,
              COALESCE(split.source_so_id, requested.netsuite_id) AS instruction_order_id
         FROM unnest($1::bigint[]) requested_id(value)
         JOIN sales_orders requested
           ON requested.netsuite_id = requested_id.value
         LEFT JOIN dispatch_scm_so_splits split
           ON split.split_so_id = requested.netsuite_id
        WHERE lower(btrim(COALESCE(requested.sales_order_type, ''))) = 'delivery'
     )
     SELECT requested.requested_order_id,
            requested.requested_order_ref,
            ${ORDER_SELECT}
       FROM requested_orders requested
       JOIN sales_orders so
         ON so.netsuite_id = requested.instruction_order_id
       LEFT JOIN sales_order_delivery_instructions instruction
         ON instruction.sales_order_id = so.netsuite_id
      ORDER BY requested.requested_order_id`,
    [ids]
  );
  const media = await mediaForOrderIds(result.rows.map((row) => row.order_id));
  return Object.fromEntries(result.rows.map((row) => {
    const detail = publicOrder(row, media.get(Number(row.order_id)) || []);
    return [String(row.requested_order_id), {
      orderId: Number(row.requested_order_id),
      orderRef: row.requested_order_ref || detail.orderRef,
      instructionOrderId: detail.orderId,
      instructionOrderRef: detail.orderRef,
      customer: detail.customer,
      revision: detail.revision,
      automatic: detail.automatic,
      additionalText: detail.additionalText,
      media: detail.media
    }];
  }));
}
