function text(value) {
  return String(value ?? "").trim();
}

function addressKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

export function expectedArrivalPoint(details = {}, destinationAddress = "", { requireAddress = false } = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {return null;}
  const address = text(details.expectedAddress ?? details.expected?.address);
  if ((requireAddress && !address) || (address && addressKey(address) !== addressKey(destinationAddress))) {return null;}
  const lat = details.expectedLatitude ?? details.expected?.latitude;
  const lng = details.expectedLongitude ?? details.expected?.longitude;
  if (![lat, lng].every(value => ["number", "string"].includes(typeof value))) {return null;}
  if (!text(lat) || !text(lng)) {return null;}
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {return null;}
  return { latitude, longitude };
}

export function arrivalVerificationPoint(record = {}, verification = {}, destinationAddress = "") {
  if (!text(record.job_id) || text(record.job_id) !== text(verification.job_id)) {return null;}
  if (!text(record.driver_login) || text(record.driver_login).toLowerCase() !== text(verification.driver_login).toLowerCase()) {return null;}
  const checked = new Date(verification.checked_at).getTime();
  const completed = new Date(record.completed_at).getTime();
  if (!verification.checked_at || !record.completed_at || !Number.isFinite(checked) || !Number.isFinite(completed) || checked > completed) {return null;}
  const point = expectedArrivalPoint(verification.details, destinationAddress, { requireAddress: true });
  return point ? { ...point, source: "driver_location_verification", verificationId: text(verification.verification_id) } : null;
}

export function arrivalFailureSummary(results = []) {
  const labels = {
    destination_coordinates_unavailable: "Destination coordinates are unavailable for the recorded stop",
    invalid_time_window: "The previous completion does not precede this stop's completion",
    truck_plate_unavailable: "The completed stop has no truck plate",
    samsara_vehicle_not_found: "The recorded truck could not be found in Samsara",
    samsara_vehicle_lookup_failed: "The Samsara truck lookup failed",
    no_gps_points: "No GPS history points were returned for the stop's travel window",
    gps_history_incomplete: "Earlier GPS history is incomplete and the start of the destination stop cannot be established",
    no_sustained_destination_cluster: "GPS history does not establish a sustained stop at the destination"
  };
  return [...new Set(results.filter(result => result.resolutionStatus === "unresolved")
    .map(result => labels[result.error] || "Arrival could not be established from the available evidence"))].join("; ");
}
