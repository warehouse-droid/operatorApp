import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const gateway = "src/google-maps-gateway.js";
const frontend = "public/dispatch.js";
const property = "test/mbt/property/google-maps-route-geometry.property.test.js";
const tests = ["test/mbt/unit/google-maps-route-geometry.red.test.js", "test/dispatch/frontend/dispatch-google-map-redraw.red.test.js", property];
const mutants = [
  { name: "swapped GeoJSON axes", file: gateway, from: "coordinates.map(([lng, lat]) => ({ lat, lng }))", to: "coordinates.map(([lat, lng]) => ({ lat, lng }))", property: true },
  { name: "omitted first route pin", file: gateway, from: "[legs[0]?.startLocation, ...legs.map((leg) => leg.endLocation)]", to: "legs.map((leg) => leg.endLocation)", property: true },
  { name: "unbounded provider geometry", file: gateway, from: "coordinates.length <= MAX_ROUTE_PATH_POINTS", to: "true", property: true },
  { name: "reject final permitted path point", file: gateway, from: "coordinates.length <= MAX_ROUTE_PATH_POINTS", to: "coordinates.length < MAX_ROUTE_PATH_POINTS", property: true },
  { name: "nullable browser latitude accepted", file: frontend, from: "Number.isFinite(point?.lat) && point.lat", to: "Number.isFinite(Number(point?.lat)) && point.lat", property: true },
  { name: "preserved canvas never redrawn", file: frontend, from: "replacement.replaceWith(state.canvas);\n  updateGoogleMapPreviewGeometry(state.canvas);", to: "replacement.replaceWith(state.canvas);", property: false },
  { name: "geometry-only estimate change ignored", file: frontend,
    from: "\n    || JSON.stringify(previousEstimate.routePath || []) !== JSON.stringify(estimate.routePath || [])\n    || JSON.stringify(previousEstimate.stopCoordinates || []) !== JSON.stringify(estimate.stopCoordinates || []);",
    to: ";", property: false },
  { name: "cache drops route geometry", file: frontend, from: "      ...normalizedRouteMapGeometry(estimate, stops.length),", to: "      // mutant: discard geometry", property: false },
  { name: "in-flight response relabelled for edited route", file: frontend,
    from: "if (!latest.load || requestPlanKey !== `${currentPlanDate}:${currentPlan?.id || \"\"}`\n      || routeEstimateMeta(latestTruck, latest.load, latestStops).signature !== meta.signature)",
    to: "if (!latest.load)", property: false }
];

function run(files) {
  const result = spawnSync(process.execPath, ["--test", ...files], { env: process.env, stdio: "pipe", timeout: 60_000 });
  if (result.error) { throw result.error; }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Run only in a disposable, writable test container without host source mounts");
}
const originals = new Map(await Promise.all([gateway, frontend].map(async (file) => [file, await readFile(file, "utf8")])));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const baseline = run(tests);
if (baseline.status !== 0) { throw new Error(`Mutation baseline failed: ${baseline.output}`); }
let killed = 0;
let propertyKilled = 0;
try {
  for (const mutant of mutants) {
    const original = originals.get(mutant.file);
    if (original.split(mutant.from).length !== 2) { throw new Error(`Non-unique mutant: ${mutant.name}`); }
    await writeFile(mutant.file, original.replace(mutant.from, mutant.to));
    const result = run(tests);
    if (result.status === 0 || !result.output.includes("not ok")) { throw new Error(`Mutant survived: ${mutant.name}`); }
    killed += 1;
    if (mutant.property) {
      const propertyResult = run([property]);
      if (propertyResult.status === 0 || !propertyResult.output.includes("not ok")) { throw new Error(`Property suite missed: ${mutant.name}`); }
      propertyKilled += 1;
    }
    process.stdout.write(`KILLED ${mutant.name}${mutant.property ? " (also property-only)" : ""}\n`);
    await writeFile(mutant.file, original);
  }
} finally {
  for (const [file, original] of originals) {
    await writeFile(file, original);
    if (hash(await readFile(file)) !== hash(original)) { throw new Error(`Restore mismatch: ${file}`); }
  }
}
const restored = run(tests);
if (restored.status !== 0) { throw new Error(`Restored source failed: ${restored.output}`); }
process.stdout.write(JSON.stringify({ killed, total: mutants.length, propertyKilled, propertyTotal: mutants.filter((mutant) => mutant.property).length, restored: true }) + "\n");
