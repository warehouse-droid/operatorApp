import crypto from "node:crypto";
import { query } from "./db.js";

const YARD_ADDRESSES = {
  "3445": "3445 Kennedy Road, Toronto, ON",
  "2967": "2967 Kennedy Road, Toronto, ON",
  "12441": "12441 Woodbine Avenue, Whitchurch-Stouffville, ON"
};

const VENDOR_YARDS = [
  { vendor: "UNILOCK", yard: "UNILOCK Ayr", aliases: ["ayr"], windowStart: "07:00", windowEnd: "17:00", instructions: "", address: "2977 Cedar Creek Rd RR#1, Ayr, ON N0B 1E0" },
  { vendor: "UNILOCK", yard: "UNILOCK Gormley", aliases: ["gormley", "gromley"], windowStart: "07:00", windowEnd: "17:00", instructions: "Appointment needed", address: "37 Gormley Rd E, Gormley, ON L0H 1G0" },
  { vendor: "UNILOCK", yard: "UNILOCK Pickering", aliases: ["pickering"], windowStart: "08:00", windowEnd: "16:00", instructions: "", address: "1890 Clements Rd, Pickering, ON L1W 3R8" },
  { vendor: "UNILOCK", yard: "UNILOCK Georgetown", aliases: ["georgetown"], windowStart: "07:00", windowEnd: "17:00", instructions: "", address: "287 Armstrong Ave, Georgetown, ON L7G 4X6" },
  { vendor: "BWS", yard: "BWS Uxbridge", aliases: ["uxbridge"], windowStart: "07:00", windowEnd: "16:00", instructions: "Mon-Fri arrive by 15:30. Saturday 07:00-12:00 arrive by 11:30", address: "65 Anderson Blvd, Uxbridge, ON L9P 0C7" },
  { vendor: "BWS", yard: "BWS Woodbridge", aliases: ["woodbridge"], windowStart: "", windowEnd: "", instructions: "", address: "8821 Weston Rd, Woodbridge, ON L4L 1A6" },
  { vendor: "PERMACON", yard: "PERMACON Milton", aliases: ["milton"], windowStart: "07:00", windowEnd: "17:00", instructions: "Arrive by 16:30", address: "8375 5 Side Rd, Milton, ON L7J 0A1" },
  { vendor: "PERMACON", yard: "PERMACON Cambridge", aliases: ["cambridge"], windowStart: "07:00", windowEnd: "16:30", instructions: "Arrive by 16:00", address: "1081 Rife Rd, Cambridge, ON N1R 5S3" },
  { vendor: "PERMACON", yard: "PERMACON Bolton", aliases: ["bolton"], windowStart: "07:00", windowEnd: "16:30", instructions: "Arrive by 16:00", address: "3 Betomat Ct. Bolton, ON L7E 2V9" },
  { vendor: "TECHO", yard: "TECHO BLOC Vaughan", aliases: ["techo bloc vaughan", "vaughan", "north york", "arrow"], windowStart: "07:00", windowEnd: "17:00", instructions: "", address: "720 Arrow Rd. North York, ON M9M 2M1" },
  { vendor: "TECHO", yard: "TECHO BLOC Ayr", aliases: ["techo bloc ayr", "ayr", "cedar creek"], windowStart: "07:00", windowEnd: "17:00", instructions: "", address: "2852 Cedar Creek Rd, Ayr, ON N0B 1E0" },
  { vendor: "OAKVILLE STONE", yard: "Oakville Stone", aliases: ["oakville stone", "kamato"], windowStart: "07:30", windowEnd: "15:30", instructions: "", address: "960 Kamato Rd, Mississauga, ON L4W 2R6" },
  { vendor: "BEAVER VALLEY", yard: "Beaver Valley Stone", aliases: ["beaver", "keele", "maple"], windowStart: "07:00", windowEnd: "15:00", instructions: "Arrive by 14:30", address: "12350 Keele St, Maple, ON L6A 2C4" },
  { vendor: "RYMAR", yard: "Rymar", aliases: ["rymar", "oakville"], windowStart: "08:00", windowEnd: "16:00", instructions: "Saturday 08:00-15:00", address: "1273 North Service Rd E, Unit F10, Oakville, ON L6H 1A7" },
  { vendor: "CFC", yard: "CFC", aliases: ["cfc", "satellite"], windowStart: "08:30", windowEnd: "16:00", instructions: "", address: "5115 Satellite Dr, Mississauga, ON L4W 5B6" },
  { vendor: "PORCEA", yard: "Porcea/STONEarch", aliases: ["porcea", "stonearch", "coleraine"], windowStart: "08:00", windowEnd: "16:30", instructions: "", address: "12393 Coleraine Dr, Bolton, ON L7E 3B4" },
  { vendor: "STONEARCH", yard: "Porcea/STONEarch", aliases: ["porcea", "stonearch", "coleraine"], windowStart: "08:00", windowEnd: "16:30", instructions: "", address: "12393 Coleraine Dr, Bolton, ON L7E 3B4" },
  { vendor: "BANAS", yard: "Banas Stone", aliases: ["banas", "king street"], windowStart: "08:00", windowEnd: "15:45", instructions: "", address: "8144 King Street Bolton, ON L7E 0T8" },
  { vendor: "STONEROX", yard: "StoneRox", aliases: ["xrts", "stonerox", "bethesda", "stouffville"], windowStart: "08:00", windowEnd: "15:00", instructions: "Mon-Thu 08:00-15:00. Friday 08:00-13:00", address: "5291 Bethesda Side Rd, Stouffville, ON L4A 4A7" },
  { vendor: "TRIPLE H", yard: "Triple H", aliases: ["triple h", "putnam"], windowStart: "08:00", windowEnd: "17:00", instructions: "", address: "4366 Breen Rd., Putnam ON, N0L 2B0" },
  { vendor: "MA-CO", yard: "Ma-Co Clay Products", aliases: ["ma-co", "maco", "bright", "oxford"], windowStart: "07:00", windowEnd: "16:30", instructions: "", address: "896474 Oxford County Rd. 3, Bright, ON N0J1B0" }
];

function rowToVendorYard(row) {
  return {
    id: row.id,
    vendor: row.vendor,
    yard: row.yard,
    aliases: String(row.aliases || "").split(",").map((item) => item.trim()).filter(Boolean),
    dayLabel: row.day_label,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    instructions: row.instructions,
    address: row.address,
    active: row.active
  };
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseWindowValue(value, fallback) {
  const [start, end] = String(value || "").split("-").map((item) => item?.trim() || "");
  return {
    start: /^\d{2}:\d{2}$/.test(start) ? start : fallback.start,
    end: /^\d{2}:\d{2}$/.test(end) ? end : fallback.end
  };
}

export async function listDispatchParserRules() {
  const result = await query(
    `SELECT rule_key, rule_value, description
       FROM dispatch_parser_rules
      ORDER BY rule_key`
  );
  return result.rows.map((row) => ({
    key: row.rule_key,
    value: row.rule_value,
    description: row.description
  }));
}

async function parserConfig() {
  try {
    const rows = await listDispatchParserRules();
    const rules = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      addressLabels: csv(rules.address_labels || "Delivery Address,Address,Ship to,Deliver to,Add,送货地址"),
      timeLabels: csv(rules.time_labels || "Delivery Time,Delivery Window,送货时间"),
      instructionLabels: csv(rules.instruction_labels || "Drop-off Loc,Drop off,Drop-off,砖的放置,放置"),
      amTerms: csv(rules.am_terms || "AM,上午"),
      pmTerms: csv(rules.pm_terms || "PM,下午"),
      noonTerms: csv(rules.noon_terms || "noon,中午"),
      amWindow: parseWindowValue(rules.am_window, { start: "08:00", end: "12:00" }),
      pmWindow: parseWindowValue(rules.pm_window, { start: "12:00", end: "22:00" }),
      noonWindow: parseWindowValue(rules.noon_window, { start: "11:00", end: "14:00" }),
      wholeDayWindow: parseWindowValue(rules.whole_day_window, { start: "08:00", end: "17:00" })
    };
  } catch {
    return {
      addressLabels: ["Delivery Address", "Address", "Ship to", "Deliver to", "Add", "送货地址"],
      timeLabels: ["Delivery Time", "Delivery Window", "送货时间"],
      instructionLabels: ["Drop-off Loc", "Drop off", "Drop-off", "砖的放置", "放置"],
      amTerms: ["AM", "上午"],
      pmTerms: ["PM", "下午"],
      noonTerms: ["noon", "中午"],
      amWindow: { start: "08:00", end: "12:00" },
      pmWindow: { start: "12:00", end: "22:00" },
      noonWindow: { start: "11:00", end: "14:00" },
      wholeDayWindow: { start: "08:00", end: "17:00" }
    };
  }
}

export async function updateDispatchParserRule(key, value) {
  const result = await query(
    `UPDATE dispatch_parser_rules
        SET rule_value = $2,
            updated_at = now()
      WHERE rule_key = $1
      RETURNING rule_key, rule_value, description`,
    [key, value ?? ""]
  );
  return result.rows[0] ? {
    key: result.rows[0].rule_key,
    value: result.rows[0].rule_value,
    description: result.rows[0].description
  } : null;
}

export async function listOllamaAudit({ limit = 80 } = {}) {
  const result = await query(
    `SELECT id, parser_type, model, source_ref, prompt, response, parsed, error, created_at
       FROM dispatch_ollama_audit
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 80, 1), 300)]
  );
  return result.rows.map((row) => ({
    id: row.id,
    parserType: row.parser_type,
    model: row.model,
    sourceRef: row.source_ref,
    prompt: row.prompt,
    response: row.response,
    parsed: row.parsed,
    error: row.error,
    createdAt: row.created_at
  }));
}

async function writeOllamaAudit({ parserType, sourceRef = "", prompt, response = "", parsed = null, error = "" }) {
  try {
    await query(
      `INSERT INTO dispatch_ollama_audit
        (parser_type, model, source_ref, prompt, response, parsed, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [parserType, "qwen3:4b-instruct", sourceRef, prompt, response, parsed ? JSON.stringify(parsed) : null, error]
    );
  } catch {
    // Audit should never block operational parsing.
  }
}

export async function listDispatchVendorYards() {
  const result = await query(
    `SELECT id, vendor, yard, aliases, day_label, window_start, window_end, instructions, address, active
       FROM dispatch_vendor_yards
      ORDER BY vendor, yard, day_label, id`
  );
  return result.rows.map(rowToVendorYard);
}

async function vendorYardsForMatching() {
  try {
    const rows = await listDispatchVendorYards();
    const active = rows.filter((row) => row.active);
    if (active.length) return active;
  } catch {
    // Migration may not be present yet during first boot; use the built-in seed.
  }
  return VENDOR_YARDS.map((yard, index) => ({
    id: index + 1,
    ...yard,
    dayLabel: yard.dayLabel || "Mon-Fri",
    active: true
  }));
}

export async function updateDispatchVendorYard(id, patch = {}) {
  const result = await query(
    `UPDATE dispatch_vendor_yards
        SET vendor = COALESCE($2, vendor),
            yard = COALESCE($3, yard),
            aliases = COALESCE($4, aliases),
            day_label = COALESCE($5, day_label),
            window_start = COALESCE($6, window_start),
            window_end = COALESCE($7, window_end),
            instructions = COALESCE($8, instructions),
            address = COALESCE($9, address),
            active = COALESCE($10, active),
            updated_at = now()
      WHERE id = $1
      RETURNING id, vendor, yard, aliases, day_label, window_start, window_end, instructions, address, active`,
    [
      id,
      patch.vendor ?? null,
      patch.yard ?? null,
      Array.isArray(patch.aliases) ? patch.aliases.join(",") : patch.aliases ?? null,
      patch.dayLabel ?? patch.day_label ?? null,
      patch.windowStart ?? patch.window_start ?? null,
      patch.windowEnd ?? patch.window_end ?? null,
      patch.instructions ?? null,
      patch.address ?? null,
      typeof patch.active === "boolean" ? patch.active : null
    ]
  );
  return result.rows[0] ? rowToVendorYard(result.rows[0]) : null;
}

function hashText(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueYards(rows) {
  const dayPriority = (day) => ({
    "Mon-Fri": 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
    Sunday: 7
  })[day] ?? 9;
  const seen = new Set();
  return [...rows].sort((a, b) => dayPriority(a.dayLabel) - dayPriority(b.dayLabel)).filter((row) => {
    const key = `${normalize(row.vendor)}|${normalize(row.yard)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasPurchaseYardClue(value, candidates = []) {
  const text = normalize(value);
  if (!text) return false;
  if (/\byard\b/.test(text)) return true;
  return candidates.some((yard) => {
    const vendorTokens = new Set(normalize(yard.vendor).split(" ").filter(Boolean));
    const yardTokens = normalize(yard.yard)
      .split(" ")
      .filter((part) => part.length >= 3 && part !== "yard" && !vendorTokens.has(part));
    const aliasTokens = yard.aliases.map(normalize).filter((part) => part.length >= 3);
    return [...yardTokens, ...aliasTokens].some((part) => text.includes(part));
  });
}

function extractJsonObject(text) {
  const jsonText = String(text || "").match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function parseTime(value, suffix = "") {
  const match = String(value || "").match(/(\d{1,2})(?::(\d{2}))?\s*(a|p|am|pm)?/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridian = (match[3] || suffix || "").toLowerCase();
  if ((meridian === "p" || meridian === "pm") && hour < 12) hour += 12;
  if ((meridian === "a" || meridian === "am") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extractRangeWindow(text) {
  const clean = String(text || "");
  const range = clean.match(/(\d{1,2}(?::\d{2})?\s*(?:a|p|am|pm)?)\s*(?:-|to|–|—)\s*(\d{1,2}(?::\d{2})?\s*(?:a|p|am|pm)?)/i);
  if (!range) return {};
  const endSuffix = (range[2].match(/(a|p|am|pm)/i) || [])[1] || "";
  return {
    windowStart: parseTime(range[1], endSuffix),
    windowEnd: parseTime(range[2])
  };
}

function extractLabelValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const label of labels) {
      const index = lower.indexOf(label.toLowerCase());
      if (index >= 0) return line.slice(index + label.length).replace(/^[:：\-\s]+/, "").trim();
    }
  }
  return "";
}

function cleanupAddress(value) {
  return String(value || "")
    .replace(/^po\s*#?\s*\d+\s*/i, "")
    .trim();
}

function hasTerm(text, terms) {
  const normalized = String(text || "").toLowerCase();
  return terms.some((term) => term && normalized.includes(String(term).toLowerCase()));
}

function hasDateLikeText(value) {
  return /\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s*月\s*\d{1,2}\s*日/i.test(String(value || ""));
}

function windowFromLabel(value, config) {
  const text = String(value || "").toLowerCase();
  const range = extractRangeWindow(text);
  if (range.windowStart || range.windowEnd) return range;
  if (hasTerm(text, config.pmTerms)) return { windowStart: config.pmWindow.start, windowEnd: config.pmWindow.end };
  if (hasTerm(text, config.amTerms)) return { windowStart: config.amWindow.start, windowEnd: config.amWindow.end };
  if (hasTerm(text, config.noonTerms)) return { windowStart: config.noonWindow.start, windowEnd: config.noonWindow.end };
  if (hasDateLikeText(text)) return { windowStart: config.wholeDayWindow.start, windowEnd: config.wholeDayWindow.end };
  return {};
}

function extractLabeledDispatchFields(text, config) {
  const deliveryAddress = cleanupAddress(extractLabelValue(text, config.addressLabels));
  const timeText = extractLabelValue(text, config.timeLabels);
  const timeWindow = windowFromLabel(timeText, config);
  const instructions = [];
  const drop = extractLabelValue(text, config.instructionLabels);
  if (drop) instructions.push(drop);
  return {
    deliveryAddress,
    windowStart: timeWindow.windowStart || "",
    windowEnd: timeWindow.windowEnd || "",
    instructions: instructions.join(" | ")
  };
}

function extractAddress(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const labelled = clean.match(/(?:address|addr|ship to|deliver to|delivery address)\s*[:\-]\s*([^|;\n]+(?:ON|Ontario)[^|;\n]*)/i);
  if (labelled) return labelled[1].trim();
  const postal = clean.match(/(\d{1,6}\s+[^|;\n]+?,?\s*(?:ON|Ontario)\b[^|;\n]*(?:[A-Z]\d[A-Z]\s?\d[A-Z]\d)?)/i);
  return postal ? postal[1].trim() : "";
}

async function parseSalesOrderWithOllama(note, { sourceRef = "" } = {}) {
  if (!note || !globalThis.fetch) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "qwen3:4b-instruct",
        stream: false,
        prompt: `You extract dispatch data from messy sales-order notes for a yard delivery planner.

Return strict JSON only:
{"deliveryAddress":"","windowStart":"","windowEnd":"","instructions":""}

Rules:
1. deliveryAddress must be the actual delivery destination only. Never copy the whole note.
2. English labels:
   - "Add:", "Address:", "Delivery Address:", "Ship to:" mean deliveryAddress.
   - "Delivery Time:" means delivery time window.
   - "Drop-off Loc:" and similar placement notes go to instructions, not address.
   - "Tel:", "Phone:", PO number, account terms, and contact info are not address.
3. Chinese labels:
   - "送货地址：" means deliveryAddress.
   - "送货时间：" means delivery time window.
   - "联系电话：" is not address.
   - "砖的放置：" / "放置" placement notes go to instructions.
4. Time output must use 24-hour HH:MM. If the note only says AM/上午, use 08:00-12:00. If it says PM/下午, use 12:00-17:00. If it says noon/中午, use 11:00-14:00. If only a date is present with no part of day, leave windowStart/windowEnd empty.
5. Preserve useful delivery instructions such as drop-off location, placement, customer on site, call ahead. Do not include address in instructions unless needed for context.
6. If a field is missing or uncertain, use an empty string.

Examples:
Note:
ON ACC
Add: Po#3005690 92 Chaplin Crescent, Toronto, ON M5P 1A5
Tel: (416) 841-2217
Delivery Time: 11/14/2025 PM
Drop-off Loc: On Grass
JSON:
{"deliveryAddress":"92 Chaplin Crescent, Toronto, ON M5P 1A5","windowStart":"12:00","windowEnd":"17:00","instructions":"Drop-off Loc: On Grass"}

Note:
送货地址：18 Stanwood Crescent, North York, ON M9M 1Z9
送货时间：11月6日中午送
联系电话：647-572-7218
砖的放置：客人在场
JSON:
{"deliveryAddress":"18 Stanwood Crescent, North York, ON M9M 1Z9","windowStart":"11:00","windowEnd":"14:00","instructions":"砖的放置：客人在场"}

NOTE TO EXTRACT:
${note}`
      })
    });
    if (!response.ok) {
      await writeOllamaAudit({ parserType: "sales-order-note", sourceRef, prompt: note, error: `HTTP ${response.status}` });
      return null;
    }
    const data = await response.json();
    const parsed = extractJsonObject(data.response);
    await writeOllamaAudit({ parserType: "sales-order-note", sourceRef, prompt: note, response: data.response || "", parsed });
    return parsed;
  } catch (error) {
    await writeOllamaAudit({ parserType: "sales-order-note", sourceRef, prompt: note, error: error.message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function parsePurchaseYardWithOllama({ vendor, memo, candidates, sourceRef = "" }) {
  if (!memo || !candidates?.length || !globalThis.fetch) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const options = candidates.map((yard) => ({
      id: yard.id,
      vendor: yard.vendor,
      yard: yard.yard,
      aliases: yard.aliases,
      address: yard.address
    }));
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "qwen3:4b-instruct",
        stream: false,
        prompt: `A purchase order memo may mention which vendor yard to pick up from, for example "Ayr Yard - Unilock". Choose exactly one yard id from the candidate list only if the memo clearly identifies it. Return strict JSON only with keys yardId and confidence. If uncertain, yardId must be empty.\n\nVendor: ${vendor || ""}\nMemo: ${memo || ""}\nCandidates: ${JSON.stringify(options)}`
      })
    });
    const auditPrompt = `Vendor: ${vendor || ""}\nMemo: ${memo || ""}\nCandidates: ${JSON.stringify(options)}`;
    if (!response.ok) {
      await writeOllamaAudit({ parserType: "purchase-order-yard", sourceRef, prompt: auditPrompt, error: `HTTP ${response.status}` });
      return null;
    }
    const data = await response.json();
    const parsed = extractJsonObject(data.response);
    await writeOllamaAudit({ parserType: "purchase-order-yard", sourceRef, prompt: auditPrompt, response: data.response || "", parsed });
    return parsed;
  } catch (error) {
    await writeOllamaAudit({ parserType: "purchase-order-yard", sourceRef, prompt: `${vendor || ""}\n${memo || ""}`, error: error.message });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichSalesOrderDispatch(order) {
  const memo = order.memo || order.note || order.notes || "";
  const config = await parserConfig();
  const labeled = extractLabeledDispatchFields(memo, config);
  const fallback = {
    dispatch_address: labeled.deliveryAddress || "",
    dispatch_window_start: labeled.windowStart || "",
    dispatch_window_end: labeled.windowEnd || "",
    dispatch_instructions: labeled.instructions || memo,
    dispatch_parse_source: labeled.deliveryAddress || labeled.windowStart || labeled.instructions ? "label-parser" : "ollama-unparsed",
    dispatch_note_hash: hashText(memo)
  };
  if (labeled.deliveryAddress || labeled.windowStart || labeled.windowEnd) return fallback;
  const parsed = await parseSalesOrderWithOllama(memo, { sourceRef: order.tranid || order.id || "" });
  if (!parsed) return fallback;
  return {
    dispatch_address: parsed.deliveryAddress || parsed.address || "",
    dispatch_window_start: parsed.windowStart || fallback.dispatch_window_start,
    dispatch_window_end: parsed.windowEnd || fallback.dispatch_window_end,
    dispatch_instructions: parsed.instructions || fallback.dispatch_instructions,
    dispatch_parse_source: "ollama:qwen3:4b-instruct",
    dispatch_note_hash: fallback.dispatch_note_hash
  };
}

export function enrichTransferDispatch(order) {
  return {
    dispatch_address: YARD_ADDRESSES[String(order.destination_location || order.destination_location_id)] || order.destination_location || "",
    dispatch_window_start: "",
    dispatch_window_end: "",
    dispatch_instructions: "Transfer order. No time restriction.",
    dispatch_vendor_yard: order.source_location || "",
    dispatch_parse_source: "yard-location",
    dispatch_note_hash: hashText(`${order.source_location_id}|${order.destination_location_id}|${order.memo || ""}`)
  };
}

export async function enrichPurchaseOrderDispatch(order) {
  const vendorYards = uniqueYards(await vendorYardsForMatching());
  const haystack = normalize(`${order.vendor || ""} ${order.memo || ""} ${order.tranid || ""}`);
  const vendorName = normalize(order.vendor);
  const exactVendorCandidates = uniqueYards(vendorYards.filter((yard) => {
    const vendorParts = normalize(yard.vendor).split(" ").filter(Boolean);
    return vendorParts.some((part) => vendorName.includes(part));
  }));
  let candidate = vendorYards.find((yard) => {
    const vendorMatch = normalize(yard.vendor).split(" ").some((part) => part && vendorName.includes(part));
    const aliasMatch = yard.aliases.some((alias) => haystack.includes(normalize(alias)));
    return aliasMatch && (vendorMatch || haystack.includes(normalize(yard.vendor)));
  }) || vendorYards.find((yard) => haystack.includes(normalize(yard.yard)));
  let parseSource = candidate ? "vendor-yard-table" : "unmatched-vendor";
  if (!candidate && exactVendorCandidates.length && hasPurchaseYardClue(`${order.vendor || ""} ${order.memo || ""}`, exactVendorCandidates)) {
    const parsed = await parsePurchaseYardWithOllama({
      vendor: order.vendor,
      memo: order.memo,
      candidates: exactVendorCandidates,
      sourceRef: order.tranid || order.id || ""
    });
    const parsedId = String(parsed?.yardId || "");
    candidate = parsedId ? exactVendorCandidates.find((yard) => String(yard.id) === parsedId) : null;
    if (candidate) parseSource = "ollama:po-yard";
  }
  if (!candidate && exactVendorCandidates.length === 1 && normalize(order.memo).includes(normalize(exactVendorCandidates[0].yard))) {
    candidate = exactVendorCandidates[0];
    parseSource = "vendor-yard-table";
  }
  return {
    dispatch_address: candidate?.address || "",
    dispatch_window_start: candidate?.windowStart || "",
    dispatch_window_end: candidate?.windowEnd || "",
    dispatch_instructions: candidate ? `${candidate.dayLabel || ""}${candidate.instructions ? ` | ${candidate.instructions}` : ""}`.trim() : "",
    dispatch_vendor_yard: candidate?.yard || "",
    dispatch_parse_source: parseSource,
    dispatch_note_hash: hashText(`${order.vendor || ""}|${order.memo || ""}`)
  };
}

export async function upsertDispatchVendorYard(patch = {}) {
  const result = await query(
    `INSERT INTO dispatch_vendor_yards
      (vendor, yard, aliases, day_label, window_start, window_end, instructions, address, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (vendor, yard, day_label)
     DO UPDATE SET
       aliases = EXCLUDED.aliases,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       instructions = EXCLUDED.instructions,
       address = EXCLUDED.address,
       active = EXCLUDED.active,
       updated_at = now()
     RETURNING id, vendor, yard, aliases, day_label, window_start, window_end, instructions, address, active`,
    [
      patch.vendor,
      patch.yard,
      Array.isArray(patch.aliases) ? patch.aliases.join(",") : patch.aliases || "",
      patch.dayLabel || patch.day_label || "Monday",
      patch.windowStart || patch.window_start || "",
      patch.windowEnd || patch.window_end || "",
      patch.instructions || "",
      patch.address || "",
      typeof patch.active === "boolean" ? patch.active : true
    ]
  );
  return rowToVendorYard(result.rows[0]);
}
