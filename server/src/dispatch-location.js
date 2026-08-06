function locationText(value) {
  return String(value ?? "").trim();
}

/**
 * NetSuite renders hierarchical locations as "Parent : Child". Dispatch treats
 * every descendant as part of the root physical yard while retaining the full
 * label on the source order for display and audit evidence.
 */
export function dispatchLocationRoot(value) {
  const location = locationText(value);
  if (!location) return "";
  return location.split(/\s*:\s*/u, 1)[0].trim();
}

export function dispatchLocationKey(value) {
  return dispatchLocationRoot(value).toLowerCase();
}

export function dispatchLocationsShareYard(left, right) {
  const leftKey = dispatchLocationKey(left);
  const rightKey = dispatchLocationKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

export function uniqueDispatchLocations(values = []) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).filter((value) => {
    const key = dispatchLocationKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
