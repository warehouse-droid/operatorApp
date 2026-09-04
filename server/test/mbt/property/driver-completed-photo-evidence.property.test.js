// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import {
  DRIVER_COMPLETED_VISIT_MAX_PHOTOS,
  driverCompletedVisitStateHash,
  mergeDriverCompletedVisitPhotos,
  normalizeDriverCompletedVisitFilters,
  retainedDriverPhotoRequirement
} from "../../../src/driver-completed-photo-evidence.js";

function generator(seed = 0x7894) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

const durable = (index) => `r2://driver/driver-dropoff-photo/2026/09/02/property-${index}/evidence.jpg`;

test("S44: arbitrary retained and appended evidence remains ordered, unique, bounded, and requirement-safe", () => {
  const random = generator();
  for (let scenario = 0; scenario < 1000; scenario += 1) {
    const configured = Math.floor(random() * 9);
    const retainedCount = Math.floor(random() * 21);
    const retained = Array.from({ length: retainedCount }, (_, index) => durable(index));
    const requirement = retainedDriverPhotoRequirement({
      configuredRequiredPhotos: configured,
      retainedPhotos: retained
    });
    const expectedRequired = configured === 0 ? 0 : Math.max(2, configured);
    assert.equal(requirement.requiredPhotos, expectedRequired);
    assert.equal(requirement.retainedPhotoCount, retainedCount);
    assert.equal(requirement.remainingRequiredPhotos, Math.max(0, expectedRequired - retainedCount));
    assert.equal(requirement.maxPhotos, DRIVER_COMPLETED_VISIT_MAX_PHOTOS);

    const duplicateCount = Math.floor(random() * (retainedCount + 1));
    const uniqueAddedCount = Math.floor(random() * 5);
    const added = [
      ...retained.slice(0, duplicateCount),
      ...Array.from({ length: uniqueAddedCount }, (_, index) => durable(100 + scenario * 5 + index))
    ];
    if (retainedCount + uniqueAddedCount > DRIVER_COMPLETED_VISIT_MAX_PHOTOS) {
      assert.throws(
        () => mergeDriverCompletedVisitPhotos({ existing: retained, added }),
        (error) => error?.code === "DRIVER_COMPLETED_PHOTO_LIMIT"
      );
    } else {
      const merged = mergeDriverCompletedVisitPhotos({ existing: retained, added });
      assert.deepEqual(merged.slice(0, retainedCount), retained);
      assert.equal(new Set(merged).size, merged.length);
      assert.equal(merged.length, retainedCount + uniqueAddedCount);
    }
  }
});

test("S45: physical-visit hashes ignore member insertion order but bind every member and photo", () => {
  const random = generator(0x7895);
  for (let scenario = 0; scenario < 500; scenario += 1) {
    const memberCount = 1 + Math.floor(random() * 8);
    const members = Array.from({ length: memberCount }, (_, index) => ({
      id: index + 1,
      jobId: `job-${scenario}-${index}`,
      status: "complete",
      completedAt: `2026-09-02T12:${String(index).padStart(2, "0")}:00.000Z`
    }));
    const photos = Array.from({ length: Math.floor(random() * 8) }, (_, index) => durable(index));
    const baseline = driverCompletedVisitStateHash({ memberRecords: members, photos });
    const reversed = driverCompletedVisitStateHash({ memberRecords: [...members].reverse(), photos });
    assert.equal(reversed, baseline);
    assert.notEqual(driverCompletedVisitStateHash({
      memberRecords: members.map((member, index) => index === 0 ? { ...member, status: "in_progress" } : member),
      photos
    }), baseline);
    assert.notEqual(driverCompletedVisitStateHash({
      memberRecords: members,
      photos: [...photos, durable(1000 + scenario)]
    }), baseline);
  }
});

test("S46: hostile filter lengths and pagination values always normalize to bounded server inputs", () => {
  const random = generator(0x194);
  for (let scenario = 0; scenario < 1000; scenario += 1) {
    const filters = normalizeDriverCompletedVisitFilters({
      status: random() > 0.5 ? "completed" : `invalid-${scenario}`,
      driverLogin: ` Driver-${"x".repeat(Math.floor(random() * 500))} `,
      stopType: random() > 0.5 ? "DROP" : "unsafe",
      photoState: random() > 0.5 ? "below-requirement" : "unsafe",
      completionSource: random() > 0.5 ? "driver-offline" : "unsafe",
      q: "q".repeat(Math.floor(random() * 500)),
      cursor: Math.floor((random() - 0.25) * 1000),
      limit: Math.floor((random() - 0.25) * 1000)
    });
    assert.ok(filters.driverLogin.length <= 240);
    assert.ok(filters.q.length <= 240);
    assert.ok(filters.cursor >= 0);
    assert.ok(filters.limit >= 1 && filters.limit <= 200);
    assert.ok(["complete", "all"].includes(filters.status));
    assert.ok(["dropoff", "all"].includes(filters.stopType));
    assert.ok(["below_required", "all"].includes(filters.photoState));
    assert.ok(["driver_offline", "all"].includes(filters.completionSource));
  }
});
