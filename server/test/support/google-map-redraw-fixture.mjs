import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

// Execute the real browser functions, substituting only their environment.
// Preserve source offsets so V8 coverage refers to application lines.
export function mapFrontend(names, dependencies = {}) {
  const file = new URL("../../public/dispatch.js", import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  const optional = ["validRouteMapCoordinate", "normalizedRouteMapGeometry", "routeMapPreviewData", "updateGoogleMapPreviewGeometry"];
  const selected = [...new Set([...names, ...optional.filter((name) => source.includes(`function ${name}(`))])];
  let body = source.replace(/[^\n\r]/gu, " ");
  for (const name of selected) {
    const start = new RegExp(`^(?:async )?function ${name}\\(`, "mu").exec(source);
    assert.ok(start, `Missing production function ${name}`);
    const end = /^\}/mu.exec(source.slice(start.index));
    assert.ok(end, `Missing function end ${name}`);
    const finish = start.index + end.index + 1;
    body = body.slice(0, start.index) + source.slice(start.index, finish) + body.slice(finish);
  }
  return compileFunction(`${body}\nreturn {${selected.join(",")}};`, Object.keys(dependencies), { filename: fileURLToPath(file) })(...Object.values(dependencies));
}

export const mapPins = [{ lat: 43.3, lng: -80.45 }, { lat: 43.405, lng: -80.3 }, { lat: 43.65, lng: -79.91 }];
export const roadPath = [mapPins[0], { lat: 43.35, lng: -80.4 }, mapPins[1], { lat: 43.51, lng: -80.1 }, mapPins[2]];
export const mapStops = mapPins.map((_, index) => ({
  id: `stop-${index}`, type: "pick", label: String(index + 1), title: `Vendor ${index + 1}`,
  lat: 43.7, lng: -79.65, routeLocation: `Vendor address ${index + 1}`
}));

export function mapFixture() {
  const load = { id: "CE94489-L1", stops: structuredClone(mapStops), allowTolls: false };
  const truck = { id: "T7" };
  const state = {
    canvas: { dataset: {} }, maps: [], markers: [], paths: [], admissions: 0,
    status: { textContent: "" }, estimate: {
      source: "google_routes_v2", routeSignature: "same-route", routeEstimateId: "same-id",
      routePath: structuredClone(roadPath), stopCoordinates: structuredClone(mapPins),
      legMinutes: [25, 25], rawLegMinutes: [25, 25], totalMinutes: 50, driveMinutes: 50
    }
  };
  const google = { maps: {
    Map: class {
      constructor(canvas) { this.canvas = canvas; state.maps.push(this); }
      fitBounds() {}
    },
    Marker: class {
      constructor(options) { Object.assign(this, options); state.markers.push(this); }
      getPosition() { return this.position; }
      setMap(map) { this.map = map; }
      addListener() {}
    },
    Polyline: class {
      constructor(options) { Object.assign(this, options); state.paths.push(this); }
      setMap(map) { this.map = map; }
    },
    InfoWindow: class { open() {} close() {} },
    LatLngBounds: class {
      points = [];
      extend(point) { this.points.push(point); }
      isEmpty() { return !this.points.length; }
    }
  } };
  const dependencies = {
    document: { getElementById: (id) => id === "googleMapPreview" ? state.canvas : state.status },
    app: { querySelector: () => ({ replaceWith: (canvas) => { state.canvas = canvas; } }) },
    window: { google }, google, googleMapPreviewStates: new WeakMap(), MAP_CENTER: { lat: 43.7, lng: -79.65 },
    selectedLoad: () => ({ truck, load }), effectiveTruckForLoad: () => truck,
    mapStopsForLoad: () => load.stops, routeEstimateMeta: () => ({ id: "same-id", signature: "same-route" }),
    estimateForLoad: () => state.estimate,
    loadGoogleMaps: async () => { state.admissions += 1; return true; },
    mapMarkerIcon: (stop) => stop.label, mapMarkerInfoWindowHtml: (_load, stop) => stop.title,
    normalizedPlaceKey: (value) => String(value || "").toLowerCase()
  };
  return { state, load, truck, dependencies };
}

export const mapRenderFunctions = [
  "renderGoogleMapPreview", "captureGoogleMapPreviewState", "restoreGoogleMapPreviewState",
  "selectedGoogleMapRouteIdentity", "routeEstimateMatchesMeta", "mergeConsecutiveExactDropMarkers", "spreadOverlappingMarkers"
];
