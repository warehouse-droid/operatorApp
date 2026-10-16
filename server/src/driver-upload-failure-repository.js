import {query} from "./db.js";
import {normalizeUploadFailure, safeUploadFailureMessage} from "./driver-upload-failure.js";

export async function recordDriverUploadFailure({sessionId, driverLogin, deviceId, failure, clientVersion}) {
  const diagnostic = normalizeUploadFailure(failure);
  const result = await query(
    `WITH authorized AS (
       SELECT session_id
         FROM driver_sessions
        WHERE session_id = $1::uuid AND lower(driver_login) = lower($2)
          AND (device_id = '' OR device_id = $3)
          AND revoked_at IS NULL AND expires_at > now()
     ), inserted AS (
       INSERT INTO delivery_audit_log (actor_type, source, action, details)
       SELECT 'driver', 'driver-pwa-upload', $5, $4::jsonb
         FROM authorized
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM authorized) AS authorized,
            EXISTS (SELECT 1 FROM inserted) AS recorded`,
    [sessionId, driverLogin, deviceId, JSON.stringify({...diagnostic,
      clientVersion: clientVersion ? safeUploadFailureMessage(clientVersion).slice(0, 80) : "",
      driverLogin: String(driverLogin).toLowerCase(), deviceId, sessionId,
      serverReceivedAt: new Date().toISOString()}), `driver.photo_upload.${diagnostic.outcome}`]
  );
  if (!result.rows[0]?.authorized) {
    throw Object.assign(new Error("The Driver session does not match this device."), {status: 401, code: "DRIVER_SESSION_DEVICE_MISMATCH"});
  }
  return {ok: true, recorded: result.rows[0].recorded, failureId: diagnostic.failureId};
}
