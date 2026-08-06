// @ts-check

const REDACTED = "[REDACTED]";
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONFIGURED_SECRET_KEY = /(?:secret|token|password|credential|api[_-]?key|database[_-]?url)/i;

/**
 * Return configured values that must never survive in command evidence. The
 * key allowlist is intentionally semantic: ordinary environment values such
 * as paths and feature switches must not cause broad accidental redaction.
 *
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string[]}
 */
export function configuredMbtSecretValues(environment = process.env) {
  return [...new Set(Object.entries(environment)
    .filter(([key, value]) => CONFIGURED_SECRET_KEY.test(key) && String(value || "").length > 0)
    .map(([, value]) => String(value)))];
}

/** @param {unknown} key */
function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** @param {unknown} key */
function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("token")
    || normalized.includes("credential")
    || normalized.includes("cardnumber")
    || normalized.includes("bankaccount")
    || normalized.includes("routingnumber")
    || normalized.includes("cvv");
}

/**
 * @param {unknown} value
 * @param {{secretValues?: readonly unknown[]}} [options]
 * @returns {unknown}
 */
export function redactMbtValue(value, { secretValues = [] } = {}) {
  const knownSecrets = secretValues
    .map((secret) => String(secret || ""))
    .filter(Boolean);
  const seen = new WeakSet();

  /** @param {unknown} current @returns {unknown} */
  function redact(current) {
    if (typeof current === "string") {
      return knownSecrets.some((secret) => current.includes(secret)) ? REDACTED : current;
    }
    if (current === null || typeof current !== "object") {
      return current;
    }
    if (seen.has(current)) {
      return REDACTED;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      return current.map(redact);
    }

    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [key, child] of Object.entries(current)) {
      if (DANGEROUS_KEYS.has(key)) {
        continue;
      }
      result[key] = isSecretKey(key) ? REDACTED : redact(child);
    }
    return result;
  }

  return redact(value);
}
