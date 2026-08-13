export const DRIVER_PWA_VERSION_HEADER = "X-MBBS-Driver-Version";
export const DRIVER_PWA_CURRENT_VERSION = "2026.08.12.3";
export const DRIVER_PWA_MINIMUM_VERSION = "2026.08.12.3";

const VERSION_EXEMPT_PATHS = new Set([
  "/client-version",
  "/network-health",
  "/login",
  "/me",
  "/logout",
  "/sync-status",
  // Evidence-drain routes stay available to an older worker so a deployment
  // cannot strand locally saved events or photos. Interactive routes below
  // still force that client to close and reopen before it can continue.
  "/offline-sync",
  "/photo-upload-token"
]);

function numericVersionParts(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null;
  const parts = normalized.split(".").map((part) => Number(part));
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function compareDriverPwaVersions(left, right) {
  const leftParts = numericVersionParts(left);
  const rightParts = numericVersionParts(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

export function driverPwaVersionIsSupported(value) {
  const comparison = compareDriverPwaVersions(value, DRIVER_PWA_MINIMUM_VERSION);
  return comparison !== null && comparison >= 0;
}

export function driverPwaVersionDetails(value) {
  const clientVersion = String(value || "").trim();
  const supported = driverPwaVersionIsSupported(clientVersion);
  return {
    currentVersion: DRIVER_PWA_CURRENT_VERSION,
    minimumVersion: DRIVER_PWA_MINIMUM_VERSION,
    clientVersion: clientVersion || null,
    isCurrent: clientVersion === DRIVER_PWA_CURRENT_VERSION,
    supported,
    updateRequired: !supported,
    reopenRequired: !supported,
    headerName: DRIVER_PWA_VERSION_HEADER
  };
}

export function driverPwaVersionGate(req, res, next) {
  const routePath = String(req.path || req.url || "").split("?")[0];
  const version = req.get?.(DRIVER_PWA_VERSION_HEADER) || req.headers?.[DRIVER_PWA_VERSION_HEADER.toLowerCase()];
  const details = driverPwaVersionDetails(version);
  res.setHeader("Vary", DRIVER_PWA_VERSION_HEADER);
  res.setHeader("X-MBBS-Driver-Current-Version", DRIVER_PWA_CURRENT_VERSION);
  res.setHeader("X-MBBS-Driver-Minimum-Version", DRIVER_PWA_MINIMUM_VERSION);
  if (VERSION_EXEMPT_PATHS.has(routePath)) return next();
  if (details.supported) return next();

  return res.status(426).json({
    code: "DRIVER_PWA_UPDATE_REQUIRED",
    error: "This Driver PWA is out of date. Close it completely and reopen it before continuing.",
    ...details,
    preserveLocalEvidence: true,
    guidance: "Do not clear browser data. Close every Driver PWA window, then reopen the Driver PWA so it can load the latest version. Saved offline evidence remains on this device."
  });
}
