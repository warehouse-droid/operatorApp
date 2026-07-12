const monitorApp = document.getElementById("dispatchMonitorApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";
const displayDate = (value) => window.MBBS_I18N?.displayDate(value) || "";
const MAP_CENTER = { lat: 43.82, lng: -79.45 };
const LAST_KNOWN_FALLBACK_MS = 10 * 60 * 1000;
const TRUCK_COLORS = [
  "#155eef", "#0f8f4f", "#b42318", "#7a2ea8", "#b54708",
  "#027a8f", "#c11574", "#475467", "#d92d20", "#039855",
  "#6941c6", "#dc6803", "#175cd3", "#0086c9", "#7f56d9",
  "#079455", "#ba24d5", "#ca8504", "#344054", "#e31b54"
];

let monitorOperator = null;
let monitorConfig = { googleMapsApiKey: "" };
let monitorData = { trucks: [], trails: {}, yards: [], refreshSeconds: 10 };
let monitorError = "";
let monitorLoading = false;
let monitorTimer = null;
let monitorMap = null;
let monitorInfoWindow = null;
let monitorMarkers = [];
let monitorTrailLines = [];
let monitorTruckMarkers = new Map();
let googleMapsPromise = null;
let monitorGeocodeCache = readGeocodeCache();
let monitorLastTruckLocations = readLastTruckLocations();
let selectedTruckPlate = "";
let mapHasFitBounds = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function readGeocodeCache() {
  try {
    return JSON.parse(localStorage.getItem("mbbs.monitor.geocodeCache") || "{}");
  } catch {
    return {};
  }
}

function writeGeocodeCache() {
  try {
    localStorage.setItem("mbbs.monitor.geocodeCache", JSON.stringify(monitorGeocodeCache));
  } catch {
    // Cache is an optimization only.
  }
}

function readLastTruckLocations() {
  try {
    return JSON.parse(localStorage.getItem("mbbs.monitor.lastTruckLocations") || "{}");
  } catch {
    return {};
  }
}

function writeLastTruckLocations() {
  try {
    localStorage.setItem("mbbs.monitor.lastTruckLocations", JSON.stringify(monitorLastTruckLocations));
  } catch {
    // Last known position is only a monitor fallback.
  }
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatKmh(value) {
  const speed = Number(value);
  return Number.isFinite(speed) ? `${Math.round(speed)} km/h` : "-- km/h";
}

function normalizedAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedPlate(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function isCanadaPoint(point) {
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude);
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= 41
    && lat <= 84
    && lng >= -142
    && lng <= -52;
}

async function api(path) {
  const response = await fetch(path);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || text || "Request failed");
  return payload;
}

async function loadConfig() {
  monitorConfig = await api("/api/dispatch/config");
}

function loadGoogleMaps() {
  if (!monitorConfig.googleMapsApiKey) return Promise.resolve(false);
  if (window.google?.maps) return Promise.resolve(true);
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(monitorConfig.googleMapsApiKey)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

async function geocodeYard(yard) {
  if (Number.isFinite(Number(yard.lat)) && Number.isFinite(Number(yard.lng))) {
    const point = { lat: Number(yard.lat), lng: Number(yard.lng) };
    return isCanadaPoint(point) ? { ...yard, ...point } : yard;
  }
  const key = normalizedAddress(yard.address);
  if (!key || !window.google?.maps?.Geocoder) return yard;
  if (monitorGeocodeCache[key] && isCanadaPoint(monitorGeocodeCache[key])) return { ...yard, ...monitorGeocodeCache[key] };
  if (monitorGeocodeCache[key] && !isCanadaPoint(monitorGeocodeCache[key])) {
    delete monitorGeocodeCache[key];
    writeGeocodeCache();
  }
  const geocoder = new google.maps.Geocoder();
  return new Promise((resolve) => {
    geocoder.geocode({
      address: yard.address,
      componentRestrictions: { country: "CA" },
      region: "ca"
    }, (results, status) => {
      if (status !== "OK" || !results?.[0]?.geometry?.location) return resolve(yard);
      const point = {
        lat: results[0].geometry.location.lat(),
        lng: results[0].geometry.location.lng()
      };
      if (!isCanadaPoint(point)) return resolve(yard);
      monitorGeocodeCache[key] = point;
      writeGeocodeCache();
      resolve({ ...yard, ...point });
    });
  });
}

function svgIcon(svg, width, height, anchorX = width / 2, anchorY = height) {
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.trim())}`,
    scaledSize: new google.maps.Size(width, height),
    anchor: new google.maps.Point(anchorX, anchorY)
  };
}

function yardIcon(type) {
  const own = type === "own";
  const fill = own ? "#006f6b" : "#315a8f";
  const accent = own ? "#9ee7d8" : "#c9dcff";
  const letter = own ? "MB" : "V";
  return svgIcon(`
    <svg xmlns="http://www.w3.org/2000/svg" width="46" height="52" viewBox="0 0 46 52">
      <path d="M23 50C18.7 42.8 5 32.2 5 19C5 9.6 12.8 3 23 3s18 6.6 18 16c0 13.2-13.7 23.8-18 31Z" fill="${fill}" stroke="#fff" stroke-width="3"/>
      <path d="M13 22.5 23 14l10 8.5v10H13v-10Z" fill="${accent}"/>
      <path d="M16 21v-5h5" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>
      <text x="23" y="30" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="900" fill="${fill}">${letter}</text>
    </svg>
  `, 46, 52);
}

function truckColor(plate) {
  const text = normalizedPlate(plate);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0;
  }
  return TRUCK_COLORS[hash % TRUCK_COLORS.length];
}

function bearingDegrees(from, to) {
  const lat1 = Number(from?.lat) * Math.PI / 180;
  const lat2 = Number(to?.lat) * Math.PI / 180;
  const deltaLng = (Number(to?.lng) - Number(from?.lng)) * Math.PI / 180;
  if (![lat1, lat2, deltaLng].every(Number.isFinite)) return null;
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return Number.isFinite(bearing) ? bearing : null;
}

function rememberFreshTruckLocations(trucks = []) {
  for (const truck of trucks) {
    if (!isCanadaPoint(truck)) continue;
    const key = normalizedPlate(truck.plate);
    if (!key) continue;
    monitorLastTruckLocations[key] = {
      latitude: Number(truck.latitude),
      longitude: Number(truck.longitude),
      headingDegrees: Number.isFinite(Number(truck.headingDegrees)) ? Number(truck.headingDegrees) : null,
      speedMilesPerHour: Number(truck.speedMilesPerHour || 0) || 0,
      formattedLocation: truck.formattedLocation || "",
      locationTime: truck.locationTime || "",
      savedAt: Date.now()
    };
  }
  writeLastTruckLocations();
}

function applyLastKnownLocations(data) {
  const cutoff = Date.now() - LAST_KNOWN_FALLBACK_MS;
  return {
    ...data,
    trucks: (data.trucks || []).map((truck) => {
      if (isCanadaPoint(truck)) return { ...truck, locationStale: false };
      const fallback = monitorLastTruckLocations[normalizedPlate(truck.plate)];
      if (!fallback || Number(fallback.savedAt || 0) < cutoff || !isCanadaPoint(fallback)) return truck;
      return {
        ...truck,
        ...fallback,
        locationStale: true,
        formattedLocation: fallback.formattedLocation || truck.formattedLocation || "Last known location"
      };
    })
  };
}

function truckDirection(truck) {
  const heading = Number(truck.headingDegrees);
  if (Number.isFinite(heading)) return { degrees: ((heading % 360) + 360) % 360, source: "Samsara" };
  const rows = trailForTruck(truck.plate);
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const previous = [...rows].reverse().find((row) =>
    Math.abs(Number(row.lat) - Number(latest.lat)) > 0.00001
    || Math.abs(Number(row.lng) - Number(latest.lng)) > 0.00001
  );
  const bearing = previous ? bearingDegrees(previous, latest) : null;
  return Number.isFinite(bearing) ? { degrees: bearing, source: "Trail" } : null;
}

function truckIcon(truck) {
  const active = Boolean(truck.activeLoad);
  const plate = String(truck.plate || "").slice(0, 10);
  const fill = truckColor(truck.plate);
  const blob = active ? `<circle cx="40" cy="27" r="23" fill="#facc15" opacity=".42"/>` : "";
  const direction = truckDirection(truck);
  const arrow = direction ? `
    <g transform="rotate(${direction.degrees} 40 37)">
      <path d="M40 2 48 17h-5v13h-6V17h-5L40 2Z" fill="#111827" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
    </g>
  ` : "";
  return svgIcon(`
    <svg xmlns="http://www.w3.org/2000/svg" width="80" height="54" viewBox="0 0 80 54">
      ${blob}
      ${arrow}
      <rect x="8" y="21" width="40" height="14" rx="3" fill="${fill}" stroke="#fff" stroke-width="2.5"/>
      <path d="M48 22h12l9 9v4H48V22Z" fill="${fill}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
      <rect x="12" y="16" width="30" height="7" rx="2" fill="#d7e7ff" stroke="#fff" stroke-width="1.8"/>
      <circle cx="20" cy="38" r="5" fill="#14213d" stroke="#fff" stroke-width="1.8"/>
      <circle cx="59" cy="38" r="5" fill="#14213d" stroke="#fff" stroke-width="1.8"/>
      <rect x="8" y="3" width="64" height="16" rx="8" fill="#fff" stroke="${fill}" stroke-width="2.5"/>
      <text x="40" y="15" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" font-weight="900" fill="#101820">${plate}</text>
    </svg>
  `, 74, 50, 37, 39);
}

function markerInfoForTruck(truck) {
  const load = truck.activeLoad;
  const direction = truckDirection(truck);
  const orders = load?.orderIds?.length ? load.orderIds.join(", ") : "No active load";
  const stops = load?.stops?.length
    ? load.stops.map((stop) => `${stop.sequence}. ${stop.type.toUpperCase()} ${stop.location || stop.orderId || ""} (${stop.status})`).join("<br>")
    : "";
  return `
    <div class="monitor-info">
      <strong>${escapeHtml(truck.plate || "Truck")}</strong>
      <span>${escapeHtml(truck.formattedLocation || "")}</span>
      <span>${truck.locationStale ? "Last known" : "Updated"} ${escapeHtml(formatTime(truck.locationTime))}</span>
      <span>Speed ${escapeHtml(formatKmh(truck.estimatedKmh))}</span>
      ${direction ? `<span>Direction ${Math.round(direction.degrees)}° (${escapeHtml(direction.source)})</span>` : ""}
      ${load ? `<hr><b>${escapeHtml(load.loadName || "Load")}</b><span>${escapeHtml(orders)}</span><small>${stops}</small>` : ""}
    </div>
  `;
}

function clearMarkers() {
  monitorMarkers.forEach((marker) => marker.setMap(null));
  monitorMarkers = [];
  monitorTrailLines.forEach((line) => line.setMap(null));
  monitorTrailLines = [];
  monitorTruckMarkers = new Map();
}

function trailForTruck(plate) {
  const trails = monitorData.trails || {};
  const direct = trails[plate] || trails[normalizedPlate(plate)] || Object.entries(trails).find(([key]) => normalizedPlate(key) === normalizedPlate(plate))?.[1] || [];
  return (direct || [])
    .filter((row) => isCanadaPoint(row))
    .map((row) => ({ lat: Number(row.lat), lng: Number(row.lng) }));
}

async function renderMap() {
  const canvas = document.getElementById("monitorMap");
  if (!canvas) return;
  const available = await loadGoogleMaps();
  if (!available || !window.google?.maps) {
    canvas.innerHTML = monitorConfig.googleMapsApiKey ? "Google Maps could not load." : "Add GOOGLE_MAPS_API_KEY to enable the monitor map.";
    return;
  }
  if (!monitorMap) {
    monitorMap = new google.maps.Map(canvas, {
      center: MAP_CENTER,
      zoom: 9,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true
    });
    monitorInfoWindow = new google.maps.InfoWindow();
  }
  clearMarkers();
  const bounds = new google.maps.LatLngBounds();
  const yardPoints = await Promise.all((monitorData.yards || []).map(geocodeYard));
  yardPoints.filter((yard) => isCanadaPoint(yard)).forEach((yard) => {
    const marker = new google.maps.Marker({
      position: { lat: Number(yard.lat), lng: Number(yard.lng) },
      map: monitorMap,
      icon: yardIcon(yard.type),
      title: yard.name || yard.vendor || yard.address
    });
    marker.addListener("click", () => monitorInfoWindow.open({
      anchor: marker,
      map: monitorMap,
      content: `<strong>${escapeHtml(yard.type === "own" ? `Yard ${yard.name || yard.code}` : yard.name || yard.vendor)}</strong><br>${escapeHtml(yard.address || "")}`
    }));
    monitorMarkers.push(marker);
    bounds.extend(marker.getPosition());
  });
  (monitorData.trucks || []).forEach((truck) => {
    const key = normalizedPlate(truck.plate);
    const trail = trailForTruck(truck.plate);
    if (trail.length > 1) {
      const line = new google.maps.Polyline({
        path: trail,
        geodesic: true,
        strokeColor: truckColor(truck.plate),
        strokeOpacity: 0.82,
        strokeWeight: 5,
        map: monitorMap
      });
      monitorTrailLines.push(line);
      trail.forEach((point) => bounds.extend(point));
    }
    if (!isCanadaPoint(truck)) return;
    const marker = new google.maps.Marker({
      position: { lat: Number(truck.latitude), lng: Number(truck.longitude) },
      map: monitorMap,
      icon: truckIcon(truck),
      title: truck.plate || "Truck"
    });
    marker.addListener("click", () => monitorInfoWindow.open({
      anchor: marker,
      map: monitorMap,
      content: markerInfoForTruck(truck)
    }));
    monitorMarkers.push(marker);
    if (key) monitorTruckMarkers.set(key, marker);
    bounds.extend(marker.getPosition());
  });
  if (!bounds.isEmpty() && !mapHasFitBounds) {
    monitorMap.fitBounds(bounds, 50);
    mapHasFitBounds = true;
  }
  if (selectedTruckPlate) focusTruckOnMap(selectedTruckPlate);
}

function focusTruckOnMap(plate) {
  selectedTruckPlate = plate || selectedTruckPlate;
  const truck = (monitorData.trucks || []).find((item) => normalizedPlate(item.plate) === normalizedPlate(selectedTruckPlate));
  const marker = monitorTruckMarkers.get(normalizedPlate(selectedTruckPlate));
  if (!monitorMap || !truck || !marker) return;
  monitorMap.panTo(marker.getPosition());
  if (monitorMap.getZoom() < 13) monitorMap.setZoom(13);
  monitorInfoWindow?.open({
    anchor: marker,
    map: monitorMap,
    content: markerInfoForTruck(truck)
  });
}

async function loadMonitor({ silent = false } = {}) {
  monitorError = "";
  if (!silent) {
    monitorLoading = true;
    renderMonitorApp();
  }
  try {
    const nextData = await api("/api/dispatch/monitor");
    rememberFreshTruckLocations(nextData.trucks || []);
    monitorData = applyLastKnownLocations(nextData);
  } catch (error) {
    monitorError = error.message;
  } finally {
    monitorLoading = false;
    if (silent) {
      updateMonitorUi();
    } else {
      mapHasFitBounds = false;
      renderMonitorApp();
    }
    renderMap();
    scheduleRefresh();
  }
}

function scheduleRefresh() {
  clearTimeout(monitorTimer);
  const seconds = Number(monitorData.refreshSeconds || 10);
  monitorTimer = setTimeout(() => loadMonitor({ silent: true }), Math.max(seconds, 5) * 1000);
}

function renderTruckList() {
  if (monitorLoading) return `<div class="monitor-empty">Loading truck locations...</div>`;
  if (monitorError) return `<div class="monitor-empty warning">${escapeHtml(monitorError)}</div>`;
  if (!monitorData.trucks?.length) return `<div class="monitor-empty">No trucks configured.</div>`;
  return monitorData.trucks.map((truck) => {
    const load = truck.activeLoad;
    const direction = truckDirection(truck);
    const estimatedSpeed = formatKmh(truck.estimatedKmh);
    return `
      <article class="monitor-truck-card ${load ? "active" : ""} ${normalizedPlate(selectedTruckPlate) === normalizedPlate(truck.plate) ? "selected" : ""}" style="--truck-color:${truckColor(truck.plate)}" role="button" tabindex="0" data-truck-plate="${escapeHtml(truck.plate || "")}">
        <div class="monitor-truck-head">
          <strong>${escapeHtml(truck.plate || "-")}</strong>
          <span>${load ? `Active load | ${estimatedSpeed}` : `Speed ${estimatedSpeed}`}</span>
        </div>
        <p>${escapeHtml(truck.formattedLocation || "No Samsara location returned.")}</p>
        <div class="monitor-truck-meta">
          <span>${truck.locationStale ? "Last known " : ""}${escapeHtml(formatTime(truck.locationTime))}</span>
          <span>Speed ${escapeHtml(estimatedSpeed)}</span>
          <span>${direction ? `${Math.round(direction.degrees)}° ${escapeHtml(direction.source)}` : "No direction"}</span>
        </div>
        ${load ? `
          <div class="monitor-load-blob">
            <b>${escapeHtml(load.loadName || "Load")}</b>
            <span>${escapeHtml((load.orderIds || []).join(", ") || "-")}</span>
            <small>${load.completedStops}/${load.stopCount} stops | ${escapeHtml(estimatedSpeed)}</small>
          </div>
        ` : ""}
      </article>
    `;
  }).join("");
}

function updateMonitorUi() {
  const list = document.querySelector(".monitor-list");
  if (list) list.innerHTML = renderTruckList();
  const planText = document.querySelector("[data-monitor-plan]");
  if (planText) {
    planText.textContent = monitorData.plan
      ? `Plan ${displayDate(monitorData.plan.planDate)} | ${monitorData.plan.status}`
      : "No active plan";
  }
  const refreshText = document.querySelector("[data-monitor-refresh]");
  if (refreshText) refreshText.textContent = `Auto ${Number(monitorData.refreshSeconds || 10)}s`;
  const noticeHost = document.querySelector(".monitor-map-shell");
  const existingNotice = document.querySelector(".monitor-notice");
  existingNotice?.remove();
  if (noticeHost && monitorData.samsaraError) {
    noticeHost.insertAdjacentHTML("afterbegin", `<div class="route-notice monitor-notice"><span>${escapeHtml(monitorData.samsaraError)}</span></div>`);
  }
}

function renderMonitorApp() {
  clearMarkers();
  monitorMap = null;
  monitorInfoWindow = null;
  monitorApp.innerHTML = `
    <header class="dispatch-topbar">
      <div>
        <p>${t("app.transportation", "MBBS Transportation")}</p>
        <h1>${t("dispatch.monitor", "Monitor")}</h1>
      </div>
      <div class="topbar-controls">
        <span class="autosave-pill" data-monitor-refresh>Auto ${Number(monitorData.refreshSeconds || 10)}s</span>
        <button class="primary" data-action="refresh-monitor" type="button">Refresh</button>
      </div>
      <div class="topbar-actions">
        ${languageToggle()}
        <button onclick="location.href='/dispatch'" type="button">Menu</button>
        <span class="dispatch-user">${escapeHtml(monitorOperator?.display_name || monitorOperator?.username || "")}</span>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    <section class="monitor-grid">
      <div class="monitor-map-shell">
        ${monitorData.samsaraError ? `<div class="route-notice monitor-notice"><span>${escapeHtml(monitorData.samsaraError)}</span></div>` : ""}
        <div id="monitorMap" class="monitor-map"></div>
      </div>
      <aside class="panel monitor-side">
        <div class="panel-header">
          <h2>Truck Status</h2>
          <p data-monitor-plan>${monitorData.plan ? `Plan ${escapeHtml(displayDate(monitorData.plan.planDate))} | ${escapeHtml(monitorData.plan.status)}` : "No active plan"}</p>
        </div>
        <div class="monitor-list">
          ${renderTruckList()}
        </div>
      </aside>
    </section>
  `;
}

monitorApp.addEventListener("click", (event) => {
  const truckCard = event.target.closest("[data-truck-plate]");
  if (truckCard) {
    selectedTruckPlate = truckCard.dataset.truckPlate || "";
    updateMonitorUi();
    focusTruckOnMap(selectedTruckPlate);
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "refresh-monitor") loadMonitor({ silent: true });
});

monitorApp.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const truckCard = event.target.closest("[data-truck-plate]");
  if (!truckCard) return;
  event.preventDefault();
  selectedTruckPlate = truckCard.dataset.truckPlate || "";
  updateMonitorUi();
  focusTruckOnMap(selectedTruckPlate);
});

window.addEventListener("mbbs-language-changed", () => {
  renderMonitorApp();
});

requireDispatchLogin({
  mount: monitorApp,
  async onReady(operator) {
    monitorOperator = operator;
    renderMonitorApp();
    await loadConfig();
    await loadMonitor();
  }
});
