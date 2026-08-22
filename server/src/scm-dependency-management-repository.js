import { query, withTransaction } from "./db.js";

function text(value) {
  return String(value ?? "").trim();
}

function nonnegativeInteger(value) {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function dateText(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  const match = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || "";
}

function statusError(status, code, message, details = {}) {
  return Object.assign(new Error(message), { status, code, details });
}

function mapPresence(row = {}) {
  return {
    driverLogin: row.driver_login || "",
    deviceId: row.device_id || "",
    sessionId: row.session_id || null,
    visible: row.visible === true,
    online: row.online === true,
    manifestId: row.manifest_id || null,
    planId: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    planDate: dateText(row.plan_date),
    planRevision: Number(row.plan_revision || 0),
    syncState: row.sync_state || "unknown",
    pendingEventCount: Number(row.pending_event_count || 0),
    pendingPhotoCount: Number(row.pending_photo_count || 0),
    activeJobId: row.active_job_id || "",
    heartbeatAt: row.heartbeat_at || null
  };
}

function mapRequestDevice(row = {}) {
  return {
    driverLogin: row.driver_login || "",
    deviceId: row.device_id || "",
    manifestId: row.manifest_id || null,
    state: row.state || "waiting",
    readyAt: row.ready_at || null,
    readyExpiresAt: row.ready_expires_at || null,
    installedAt: row.installed_at || null
  };
}

function mapRequest(row = {}, devices = []) {
  return {
    requestId: row.request_id || "",
    payloadHash: row.payload_hash || "",
    action: row.action || "",
    payload: row.payload || {},
    targetRef: row.target_ref || "",
    targetSignature: row.target_signature || "",
    planId: row.plan_id === null || row.plan_id === undefined ? null : Number(row.plan_id),
    planDate: dateText(row.plan_date),
    expectedPlanRevision: row.expected_plan_revision === null || row.expected_plan_revision === undefined
      ? null
      : Number(row.expected_plan_revision),
    expectedPlanDigest: row.expected_plan_digest || "",
    status: row.status || "",
    requestedBy: row.requested_by || "",
    requestedSurface: row.requested_surface || "",
    expiresAt: row.expires_at || null,
    appliedAt: row.applied_at || null,
    cancelledAt: row.cancelled_at || null,
    result: row.result || {},
    createdAt: row.created_at || null,
    devices
  };
}

function mapReceipt(row = {}) {
  return {
    requestId: row.request_id || "",
    payloadHash: row.payload_hash || "",
    action: row.action || "",
    status: row.status || "",
    result: row.result || {},
    error: row.error || {},
    actorId: row.actor_id || "",
    surface: row.surface || "",
    createdAt: row.created_at || null,
    completedAt: row.completed_at || null
  };
}

export async function recordDriverRoutePresence({
  driverLogin,
  deviceId,
  sessionId = null,
  visible = false,
  online = true,
  manifestId = null,
  planId = null,
  planDate = null,
  planRevision = 0,
  syncState = "unknown",
  pendingEventCount = 0,
  pendingPhotoCount = 0,
  activeJobId = ""
} = {}) {
  const login = text(driverLogin).toLowerCase();
  const device = text(deviceId);
  if (!login || !device) {throw statusError(400, "DRIVER_DEVICE_IDENTITY_REQUIRED", "Driver login and device ID are required.");}
  const state = ["unknown", "clean", "pending", "review"].includes(text(syncState)) ? text(syncState) : "unknown";
  const result = await query(
    `INSERT INTO driver_route_device_presence (
       driver_login, device_id, session_id, visible, online, manifest_id,
       plan_id, plan_date, plan_revision, sync_state, pending_event_count,
       pending_photo_count, active_job_id, heartbeat_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     ON CONFLICT (driver_login, device_id) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           visible = EXCLUDED.visible,
           online = EXCLUDED.online,
           manifest_id = EXCLUDED.manifest_id,
           plan_id = EXCLUDED.plan_id,
           plan_date = EXCLUDED.plan_date,
           plan_revision = EXCLUDED.plan_revision,
           sync_state = EXCLUDED.sync_state,
           pending_event_count = EXCLUDED.pending_event_count,
           pending_photo_count = EXCLUDED.pending_photo_count,
           active_job_id = EXCLUDED.active_job_id,
           heartbeat_at = now(),
           updated_at = now()
     RETURNING *`,
    [login, device, sessionId || null, visible === true, online === true, manifestId || null,
      planId || null, planDate || null, nonnegativeInteger(planRevision), state,
      nonnegativeInteger(pendingEventCount), nonnegativeInteger(pendingPhotoCount), text(activeJobId)]
  );
  return mapPresence(result.rows[0]);
}

export async function listRouteBearingDevicePresence({
  planId = null,
  planDate = "",
  driverLogins = []
} = {}) {
  const logins = [...new Set((driverLogins || []).map((value) => text(value).toLowerCase()).filter(Boolean))];
  const result = await query(
    `WITH route_devices AS (
       SELECT DISTINCT ON (lower(manifest.driver_login), manifest.device_id)
              manifest.driver_login, manifest.device_id, manifest.manifest_id,
              manifest.plan_id, manifest.plan_date, manifest.plan_revision
         FROM driver_offline_manifests manifest
        WHERE manifest.superseded_at IS NULL
          AND ($1::bigint IS NULL OR manifest.plan_id = $1)
          AND ($2::date IS NULL OR manifest.plan_date = $2)
          AND (cardinality($3::text[]) = 0 OR lower(manifest.driver_login) = ANY($3::text[]))
        ORDER BY lower(manifest.driver_login), manifest.device_id,
                 manifest.generated_at DESC, manifest.created_at DESC
     )
     SELECT route.driver_login, route.device_id, presence.session_id,
            COALESCE(presence.visible, false) AS visible,
            COALESCE(presence.online, false) AS online,
            route.manifest_id, route.plan_id, route.plan_date, route.plan_revision,
            COALESCE(presence.sync_state, 'unknown') AS sync_state,
            COALESCE(presence.pending_event_count, 0) AS pending_event_count,
            COALESCE(presence.pending_photo_count, 0) AS pending_photo_count,
            COALESCE(presence.active_job_id, '') AS active_job_id,
            presence.heartbeat_at
       FROM route_devices route
       LEFT JOIN driver_route_device_presence presence
         ON lower(presence.driver_login) = lower(route.driver_login)
        AND presence.device_id = route.device_id
        AND presence.manifest_id = route.manifest_id
      ORDER BY lower(route.driver_login), route.device_id`,
    [planId || null, text(planDate) || null, logins]
  );
  return result.rows.map(mapPresence);
}

async function loadRequest(requestId, { lock = false } = {}) {
  const request = await query(
    `SELECT * FROM scm_dependency_change_requests WHERE request_id = $1${lock ? " FOR UPDATE" : ""}`,
    [requestId]
  );
  if (!request.rowCount) {return null;}
  const devices = await query(
    `SELECT * FROM scm_dependency_change_request_devices
      WHERE request_id = $1
      ORDER BY lower(driver_login), device_id, manifest_id`,
    [requestId]
  );
  return mapRequest(request.rows[0], devices.rows.map(mapRequestDevice));
}

export async function getScmDependencyChangeRequest(requestId) {
  if (!text(requestId)) {return null;}
  return loadRequest(requestId);
}

export async function createScmDependencyChangeRequest({
  requestId,
  payloadHash,
  action,
  payload = {},
  targetRef,
  targetSignature = "",
  planId = null,
  planDate = null,
  expectedPlanRevision = null,
  expectedPlanDigest = "",
  requestedBy = "",
  requestedSurface = "scm",
  devices = [],
  expiresAt = null
} = {}) {
  return withTransaction(async () => {
    const initialStatus = devices.length ? "waiting_driver" : "driver_ready";
    const inserted = await query(
      `INSERT INTO scm_dependency_change_requests (
         request_id, payload_hash, action, payload, target_ref, target_signature,
         plan_id, plan_date, expected_plan_revision, expected_plan_digest,
         status, requested_by, requested_surface, expires_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 COALESCE($14::timestamptz, now() + interval '30 minutes'))
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [requestId, text(payloadHash), text(action), JSON.stringify(payload || {}), text(targetRef),
        text(targetSignature), planId || null, planDate || null,
        expectedPlanRevision === null ? null : nonnegativeInteger(expectedPlanRevision),
        text(expectedPlanDigest), initialStatus, text(requestedBy), text(requestedSurface) || "scm", expiresAt]
    );
    if (!inserted.rowCount) {
      const existing = await loadRequest(requestId, { lock: true });
      if (existing?.payloadHash !== text(payloadHash)) {
        throw statusError(409, "DEPENDENCY_REQUEST_ID_REUSED", "This request ID was already used for different dependency data.");
      }
      return existing;
    }
    for (const entry of devices) {
      await query(
        `INSERT INTO scm_dependency_change_request_devices (
           request_id, driver_login, device_id, manifest_id
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [requestId, text(entry.driverLogin).toLowerCase(), text(entry.deviceId), entry.manifestId]
      );
    }
    return loadRequest(requestId);
  });
}

export async function acknowledgeScmDependencyChangeRequest({
  requestId,
  driverLogin,
  deviceId,
  manifestId,
  readinessTokenHash,
  readyExpiresAt
} = {}) {
  return withTransaction(async () => {
    const request = await loadRequest(requestId, { lock: true });
    if (!request) {throw statusError(404, "DEPENDENCY_CHANGE_REQUEST_NOT_FOUND", "The pending route change was not found.");}
    if (!["waiting_driver", "driver_ready"].includes(request.status)) {
      throw statusError(409, "DEPENDENCY_CHANGE_REQUEST_NOT_PENDING", "This route change is no longer waiting for Driver readiness.");
    }
    const updated = await query(
      `UPDATE scm_dependency_change_request_devices
          SET state = 'ready', readiness_token_hash = $5,
              ready_at = now(), ready_expires_at = $6, updated_at = now()
        WHERE request_id = $1
          AND lower(driver_login) = lower($2)
          AND device_id = $3
          AND manifest_id = $4
          AND state IN ('waiting', 'ready')
        RETURNING request_id`,
      [requestId, text(driverLogin), text(deviceId), manifestId, text(readinessTokenHash), readyExpiresAt]
    );
    if (!updated.rowCount) {
      throw statusError(409, "DRIVER_ROUTE_DEVICE_MISMATCH", "This Driver device no longer matches the pending route request.");
    }
    const waiting = await query(
      `SELECT count(*)::int AS count
         FROM scm_dependency_change_request_devices
        WHERE request_id = $1 AND state <> 'ready'`,
      [requestId]
    );
    if (Number(waiting.rows[0]?.count || 0) === 0) {
      await query(
        `UPDATE scm_dependency_change_requests
            SET status = 'driver_ready', updated_at = now()
          WHERE request_id = $1 AND status = 'waiting_driver'`,
        [requestId]
      );
    }
    return loadRequest(requestId);
  });
}

export async function listDriverPendingRouteRequests({ driverLogin, deviceId = "" } = {}) {
  const result = await query(
    `SELECT request.request_id, request.action, request.plan_id,
            request.plan_date::text AS plan_date, request.status,
            request.expires_at, request.created_at,
            device.device_id, device.manifest_id, device.state,
            device.ready_at, device.ready_expires_at
       FROM scm_dependency_change_requests request
       JOIN scm_dependency_change_request_devices device
         ON device.request_id = request.request_id
      WHERE lower(device.driver_login) = lower($1)
        AND ($2 = '' OR device.device_id = $2)
        AND request.status IN ('waiting_driver', 'driver_ready')
        AND request.expires_at > now()
      ORDER BY request.created_at, request.request_id`,
    [text(driverLogin), text(deviceId)]
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    action: row.action,
    planId: row.plan_id === null ? null : Number(row.plan_id),
    planDate: row.plan_date || "",
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    deviceId: row.device_id,
    manifestId: row.manifest_id,
    deviceState: row.state,
    readyAt: row.ready_at || null,
    readyExpiresAt: row.ready_expires_at || null
  }));
}

export async function cancelScmDependencyChangeRequest(requestId, actorId = "") {
  return withTransaction(async () => {
    const result = await query(
      `UPDATE scm_dependency_change_requests
          SET status = 'cancelled', cancelled_at = now(),
              result = result || jsonb_build_object('cancelledBy', $2::text), updated_at = now()
        WHERE request_id = $1 AND status IN ('waiting_driver', 'driver_ready')
        RETURNING request_id`,
      [requestId, text(actorId)]
    );
    if (result.rowCount) {await query(
      `UPDATE scm_dependency_change_request_devices
          SET state = 'cancelled', updated_at = now()
        WHERE request_id = $1 AND state IN ('waiting', 'ready')`,
      [requestId]
    );}
    return loadRequest(requestId);
  });
}

export async function markScmDependencyChangeRequestApplied(requestId, result = {}) {
  const updated = await query(
    `UPDATE scm_dependency_change_requests
        SET status = 'applied', applied_at = now(), result = $2::jsonb, updated_at = now()
      WHERE request_id = $1 AND status = 'driver_ready'
      RETURNING request_id`,
    [requestId, JSON.stringify(result || {})]
  );
  if (!updated.rowCount) {throw statusError(409, "DRIVER_ROUTE_NOT_READY", "Every route-bearing Driver device must be ready before applying.");}
  await query(
    `UPDATE scm_dependency_change_request_devices
        SET state = 'installed', installed_at = now(), updated_at = now()
      WHERE request_id = $1 AND state = 'ready'`,
    [requestId]
  );
  return loadRequest(requestId);
}

export async function reserveScmDependencyActionReceipt({
  requestId,
  payloadHash,
  action,
  actorId = "",
  surface = "scm"
} = {}) {
  const inserted = await query(
    `INSERT INTO scm_dependency_action_receipts (
       request_id, payload_hash, action, actor_id, surface
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING *`,
    [requestId, text(payloadHash), text(action), text(actorId), text(surface) || "scm"]
  );
  if (inserted.rowCount) {return { created: true, receipt: mapReceipt(inserted.rows[0]) };}
  const existing = await query(
    "SELECT * FROM scm_dependency_action_receipts WHERE request_id = $1 FOR UPDATE",
    [requestId]
  );
  const receipt = mapReceipt(existing.rows[0]);
  if (receipt.payloadHash !== text(payloadHash)) {
    throw statusError(409, "DEPENDENCY_REQUEST_ID_REUSED", "This request ID was already used for different dependency data.");
  }
  return { created: false, receipt };
}

export async function completeScmDependencyActionReceipt(requestId, result = {}) {
  const updated = await query(
    `UPDATE scm_dependency_action_receipts
        SET status = 'succeeded', result = $2::jsonb, error = '{}'::jsonb,
            completed_at = now(), updated_at = now()
      WHERE request_id = $1
      RETURNING *`,
    [requestId, JSON.stringify(result || {})]
  );
  if (!updated.rowCount) {throw statusError(404, "DEPENDENCY_ACTION_RECEIPT_NOT_FOUND", "The dependency action receipt was not found.");}
  return mapReceipt(updated.rows[0]);
}

export async function failScmDependencyActionReceipt(requestId, error = {}) {
  const details = typeof error === "object" && error !== null
    ? error
    : { message: text(error) };
  const updated = await query(
    `UPDATE scm_dependency_action_receipts
        SET status = 'failed', error = $2::jsonb,
            completed_at = now(), updated_at = now()
      WHERE request_id = $1
      RETURNING *`,
    [requestId, JSON.stringify(details)]
  );
  return updated.rowCount ? mapReceipt(updated.rows[0]) : null;
}

export async function getScmDependencyActionReceipt(requestId) {
  const result = await query(
    "SELECT * FROM scm_dependency_action_receipts WHERE request_id = $1",
    [requestId]
  );
  return result.rowCount ? mapReceipt(result.rows[0]) : null;
}

export async function supersedeDriverRouteArtifacts({ planId, planDate = "", requestId } = {}) {
  return withTransaction(async () => {
    const manifests = await query(
      `UPDATE driver_offline_manifests
          SET superseded_at = COALESCE(superseded_at, now()),
              superseded_by_request_id = $3,
              superseded_reason = 'scm_dependency_change',
              updated_at = now()
        WHERE ($1::bigint IS NULL OR plan_id = $1)
          AND ($2::date IS NULL OR plan_date = $2)
          AND superseded_at IS NULL
        RETURNING manifest_id`,
      [planId || null, text(planDate) || null, requestId || null]
    );
    const ids = manifests.rows.map((row) => row.manifest_id);
    const grants = ids.length ? await query(
      `UPDATE driver_offline_sync_grants
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE manifest_id = ANY($1::uuid[]) AND revoked_at IS NULL
        RETURNING grant_id`,
      [ids]
    ) : { rowCount: 0 };
    return { manifestIds: ids, revokedGrantCount: grants.rowCount };
  });
}

export async function saveDriverPushSubscription({
  driverLogin,
  deviceId,
  endpoint,
  p256dh,
  authSecret
} = {}) {
  const result = await query(
    `INSERT INTO driver_push_subscriptions (
       driver_login, device_id, endpoint, p256dh, auth_secret
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET driver_login = EXCLUDED.driver_login,
           device_id = EXCLUDED.device_id,
           p256dh = EXCLUDED.p256dh,
           auth_secret = EXCLUDED.auth_secret,
           revoked_at = NULL,
           updated_at = now()
     RETURNING id, driver_login, device_id, endpoint, created_at, updated_at`,
    [text(driverLogin).toLowerCase(), text(deviceId), text(endpoint), text(p256dh), text(authSecret)]
  );
  return result.rows[0];
}

export async function revokeDriverPushSubscription({ driverLogin, deviceId, endpoint = "" } = {}) {
  const result = await query(
    `UPDATE driver_push_subscriptions
        SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE lower(driver_login) = lower($1)
        AND device_id = $2
        AND ($3 = '' OR endpoint = $3)
        AND revoked_at IS NULL`,
    [text(driverLogin), text(deviceId), text(endpoint)]
  );
  return { revoked: result.rowCount };
}

export async function listActiveDriverPushSubscriptions(driverLogins = []) {
  const logins = [...new Set(driverLogins.map((value) => text(value).toLowerCase()).filter(Boolean))];
  if (!logins.length) {return [];}
  const result = await query(
    `SELECT driver_login, device_id, endpoint, p256dh, auth_secret
       FROM driver_push_subscriptions
      WHERE lower(driver_login) = ANY($1::text[]) AND revoked_at IS NULL`,
    [logins]
  );
  return result.rows.map((row) => ({
    driverLogin: row.driver_login,
    deviceId: row.device_id,
    subscription: {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth_secret }
    }
  }));
}
