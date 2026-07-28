/**
 * MBBS NetSuite RESTlet
 *
 * GET/POST action=health
 *   Read-only connectivity and environment probe. Pass requireSandbox=true to
 *   reject an accidental production deployment.
 *
 * GET/POST action=pickingTicket
 *   Renders a transaction picking ticket. For backward compatibility, omitting
 *   action while supplying entityId also renders a picking ticket.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(["N/error", "N/log", "N/render", "N/runtime"], (error, log, render, runtime) => {
  const VERSION = "2.0.0";
  const MAX_BASE64_CHARS = 9 * 1024 * 1024;

  function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }

  function positiveInteger(value, fieldName, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || String(value).trim() === "")) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw error.create({
        name: "MBBS_INVALID_ARGUMENT",
        message: `${fieldName} must be a positive integer.`,
        notifyOff: true
      });
    }
    return parsed;
  }

  function safeFilename(value, fallback) {
    const filename = String(value || fallback || "picking-ticket.pdf")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return filename || "picking-ticket.pdf";
  }

  function requestId() {
    return `mbbs-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  function runtimeDetails() {
    const script = runtime.getCurrentScript();
    const user = runtime.getCurrentUser();
    return {
      accountId: String(runtime.accountId || ""),
      environment: String(runtime.envType || "UNKNOWN"),
      sandbox: runtime.envType === runtime.EnvType.SANDBOX,
      executionContext: String(runtime.executionContext || ""),
      scriptId: String(script.id || ""),
      deploymentId: String(script.deploymentId || ""),
      roleId: Number.isSafeInteger(Number(user.role)) ? Number(user.role) : null,
      userId: Number.isSafeInteger(Number(user.id)) ? Number(user.id) : null,
      remainingUsage: Number(script.getRemainingUsage())
    };
  }

  function assertRequestedEnvironment(request, details) {
    if (booleanValue(request.requireSandbox, false) && !details.sandbox) {
      throw error.create({
        name: "MBBS_NOT_SANDBOX",
        message: "This request requires a NetSuite sandbox, but the RESTlet is running outside a sandbox.",
        notifyOff: true
      });
    }
  }

  function health(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    return {
      ok: true,
      action: "health",
      version: VERSION,
      requestId: id,
      checkedAt: new Date().toISOString(),
      ...details,
      capabilities: {
        health: true,
        pickingTicket: true,
        locationFilter: true,
        metadataOnly: true,
        methods: ["GET", "POST"]
      }
    };
  }

  function pickingTicket(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);

    const entityId = positiveInteger(request.entityId, "entityId");
    const locationId = positiveInteger(request.location ?? request.locationId, "location", { optional: true });
    const formId = positiveInteger(request.formId, "formId", { optional: true });
    const shipgroup = positiveInteger(request.shipgroup, "shipgroup", { optional: true });
    const includeContent = booleanValue(request.includeContent, true);
    const options = {
      entityId,
      printMode: render.PrintMode.PDF
    };
    if (locationId) options.location = locationId;
    if (formId) options.formId = formId;
    if (shipgroup) options.shipgroup = shipgroup;
    if (request.inCustLocale !== undefined && request.inCustLocale !== null && request.inCustLocale !== "") {
      options.inCustLocale = booleanValue(request.inCustLocale, false);
    }

    const usageBefore = details.remainingUsage;
    const pdf = render.pickingTicket(options);
    const contentBase64 = includeContent ? String(pdf.getContents() || "") : "";
    if (includeContent && !contentBase64) {
      throw error.create({
        name: "MBBS_EMPTY_PDF",
        message: `NetSuite rendered no picking-ticket content for transaction ${entityId}.`,
        notifyOff: true
      });
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      throw error.create({
        name: "MBBS_PDF_TOO_LARGE",
        message: `The picking ticket for transaction ${entityId} exceeds the safe RESTlet response limit.`,
        notifyOff: true
      });
    }

    const filename = safeFilename(pdf.name, `transaction-${entityId}-picking-ticket.pdf`);
    const remainingUsage = Number(runtime.getCurrentScript().getRemainingUsage());
    return {
      ok: true,
      action: "pickingTicket",
      version: VERSION,
      requestId: id,
      generatedAt: new Date().toISOString(),
      accountId: details.accountId,
      environment: details.environment,
      sandbox: details.sandbox,
      entityId,
      locationApplied: Boolean(locationId),
      locationId,
      formId,
      shipgroup,
      filename,
      contentType: "application/pdf",
      contentEncoding: "base64",
      contentIncluded: includeContent,
      contentLength: contentBase64.length,
      fileSize: Number.isFinite(Number(pdf.size)) ? Number(pdf.size) : null,
      usageUnitsConsumed: Number.isFinite(usageBefore) && Number.isFinite(remainingUsage)
        ? Math.max(0, usageBefore - remainingUsage)
        : null,
      remainingUsage,
      contentBase64
    };
  }

  function normalizedAction(request) {
    const explicit = String(request.action || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!explicit) return request.entityId ? "pickingticket" : "health";
    if (explicit === "ticket" || explicit === "render" || explicit === "renderpickingticket") return "pickingticket";
    return explicit;
  }

  function dispatch(rawRequest = {}) {
    const request = rawRequest && typeof rawRequest === "object" ? rawRequest : {};
    const id = requestId();
    const action = normalizedAction(request);
    try {
      log.audit({
        title: `MBBS RESTlet ${action}`,
        details: {
          requestId: id,
          action,
          entityId: request.entityId || null,
          locationId: request.location ?? request.locationId ?? null,
          environment: String(runtime.envType || "UNKNOWN")
        }
      });
      if (action === "health") return health(request, id);
      if (action === "pickingticket") return pickingTicket(request, id);
      throw error.create({
        name: "MBBS_UNSUPPORTED_ACTION",
        message: `Unsupported action "${String(request.action || "")}". Use health or pickingTicket.`,
        notifyOff: true
      });
    } catch (caught) {
      log.error({
        title: `MBBS RESTlet failed (${id})`,
        details: {
          requestId: id,
          action,
          code: String(caught?.name || "UNEXPECTED_ERROR"),
          message: String(caught?.message || caught)
        }
      });
      if (/^MBBS_/.test(String(caught?.name || ""))) throw caught;
      throw error.create({
        name: "MBBS_RESTLET_FAILED",
        message: `The RESTlet request failed. Review NetSuite script logs with reference ${id}.`,
        notifyOff: true
      });
    }
  }

  return {
    get: dispatch,
    post: dispatch
  };
});
