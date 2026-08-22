(function registerDriverLocationOverridePolicy(root) {
  "use strict";

  function jobId(job) {
    return String(job?.jobId || "").trim();
  }

  function create() {
    let acceptedJobId = "";

    return Object.freeze({
      accept(job) {
        const nextJobId = jobId(job);
        if (!nextJobId) return false;
        acceptedJobId = nextJobId;
        return true;
      },
      isAccepted(job) {
        const nextJobId = jobId(job);
        return Boolean(nextJobId && acceptedJobId === nextJobId);
      },
      reconcile(job) {
        if (!acceptedJobId) return false;
        if (jobId(job) === acceptedJobId) return true;
        acceptedJobId = "";
        return false;
      },
      clear() {
        acceptedJobId = "";
      }
    });
  }

  root.DriverLocationOverridePolicy = Object.freeze({ create });
})(window);
