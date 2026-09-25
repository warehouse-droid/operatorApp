export const STYLE_ROLES = Object.freeze(["headings", "itemNames", "descriptions", "labels", "quantities"]);
const areas = ["general", "detail"];
const spacing = ["compact", "standard", "spacious"];
const invalid = () => Object.assign(new Error("Invalid operator display preferences."), { status: 400 });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

export function normalizeOperatorPreferences(value = {}) {
  keys(value, ["styles", "spacing", "useDeviceKeyboard"]);
  const styles = value.styles ?? {};
  keys(styles, areas);
  const result = { styles: {}, spacing: { general: "standard", detail: "inherit" }, useDeviceKeyboard: false };
  for (const area of areas) {
    const source = styles[area] ?? {};
    keys(source, STYLE_ROLES);
    result.styles[area] = {};
    for (const role of STYLE_ROLES) {
      const style = source[role] ?? {};
      keys(style, ["fontSizePx", "color"]);
      const fontSizePx = style.fontSizePx ?? null;
      const color = style.color ?? null;
      if (fontSizePx !== null && (!Number.isInteger(fontSizePx) || fontSizePx < 8 || fontSizePx > 48)) throw invalid();
      if (color !== null && (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) throw invalid();
      result.styles[area][role] = { fontSizePx, color: color?.toLowerCase() ?? null };
    }
  }
  if (value.spacing !== undefined) {
    keys(value.spacing, areas);
    for (const area of areas) {
      const selected = value.spacing[area] ?? result.spacing[area];
      if (![...spacing, ...(area === "detail" ? ["inherit"] : [])].includes(selected)) throw invalid();
      result.spacing[area] = selected;
    }
  }
  if (value.useDeviceKeyboard !== undefined) {
    if (typeof value.useDeviceKeyboard !== "boolean") throw invalid();
    result.useDeviceKeyboard = value.useDeviceKeyboard;
  }
  return result;
}
