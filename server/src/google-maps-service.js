import { config } from "./config.js";
import { createGoogleMapsGateway } from "./google-maps-gateway.js";
import { createGoogleMapsUsageRepository } from "./google-maps-usage-repository.js";

export const googleMapsUsageRepository = createGoogleMapsUsageRepository();

export const googleMapsGateway = createGoogleMapsGateway({
  apiKey: () => config.googleMaps?.serverApiKey || "",
  mode: () => config.googleMaps?.mode || "conserve",
  admitUsage: (input) => googleMapsUsageRepository.admit(input),
  recordOutcome: (input) => googleMapsUsageRepository.recordOutcome(input)
});

export async function authorizeGoogleBrowserMap({ actorId = "", sessionId = "", automatic = true } = {}) {
  if (!config.googleMaps?.browserApiKey) {
    return { available: false, reason: "not_configured", budgetState: "normal" };
  }
  const admission = await googleMapsUsageRepository.admit({
    subsystem: "dynamic_map",
    api: "maps_javascript_dynamic_map",
    reason: automatic ? "browser_page_load" : "manual_refresh",
    fingerprint: "browser-map-session",
    automatic,
    units: 1,
    actorId,
    sessionId,
    mode: config.googleMaps?.mode || "conserve"
  });
  return admission.admitted
    ? {
        available: true,
        googleMapsApiKey: config.googleMaps.browserApiKey,
        budgetState: admission.budgetState,
        ledgerId: admission.ledgerId
      }
    : {
        available: false,
        reason: admission.reason,
        budgetState: admission.budgetState
      };
}
