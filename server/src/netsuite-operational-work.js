export function createNetSuiteOperationalWorkRegistry() {
  const activeByLabel = new Map();
  let activeCount = 0;

  const snapshot = () => ({
    activeCount,
    labels: [...activeByLabel.keys()].sort()
  });

  return Object.freeze({
    isActive() {
      return activeCount > 0;
    },
    snapshot,
    async run(label, work) {
      if (typeof work !== "function") {
        throw new TypeError("NetSuite operational work requires a function.");
      }
      const cleanLabel = String(label || "netsuite.operational").trim()
        || "netsuite.operational";
      activeCount += 1;
      activeByLabel.set(cleanLabel, (activeByLabel.get(cleanLabel) || 0) + 1);
      try {
        return await work();
      } finally {
        activeCount -= 1;
        const remaining = (activeByLabel.get(cleanLabel) || 1) - 1;
        if (remaining > 0) activeByLabel.set(cleanLabel, remaining);
        else activeByLabel.delete(cleanLabel);
      }
    }
  });
}

const netSuiteOperationalWorkRegistry = createNetSuiteOperationalWorkRegistry();

export function isNetSuiteOperationalWorkActive() {
  return netSuiteOperationalWorkRegistry.isActive();
}

export function netSuiteOperationalWorkSnapshot() {
  return netSuiteOperationalWorkRegistry.snapshot();
}

export function withNetSuiteOperationalWork(label, work) {
  return netSuiteOperationalWorkRegistry.run(label, work);
}
