// @ts-check
/** @param {string} originalUrl */
export function operatorRequestPath(originalUrl) {
  // Keep route boundaries encoded; Express decodes each captured parameter.
  return (originalUrl.split("?")[0] || "").replace(/\/$/, "");
}
/** @param {string} [encodedId] */
export function operatorRouteId(encodedId = "") {
  try {
    return decodeURIComponent(encodedId);
  } catch {
    throw Object.assign(new Error("Invalid URL identifier encoding."), { status: 400 });
  }
}
