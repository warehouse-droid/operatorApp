import crypto from "node:crypto";

import { config } from "./config.js";
import { query } from "./db.js";

const TRANSLATION_TIMEOUT_MS = 12_000;
const MAX_TRANSLATED_TEXT_LENGTH = 10_000;
const CJK_TEXT = /\p{Script=Han}/u;
const PROTECTED_VALUE = /https?:\/\/[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b|\+?\d[\d().,/ -]{0,24}\d|\b\d+(?:[.,]\d+)?\b/giu;
const PLACEHOLDER = /__MBBS_TOKEN_\d+__/gu;
const translationInflight = new Map();

function normalizedText(value) {
  return String(value || "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim();
}

export function normalizeDeliveryInstructionLanguage(value) {
  return String(value || "").trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function detectDeliveryInstructionLanguage(value) {
  return CJK_TEXT.test(normalizedText(value)) ? "zh-CN" : "en";
}

function protectTranslationValues(value) {
  const values = [];
  const text = value.replace(PROTECTED_VALUE, (match) => {
    const placeholder = `__MBBS_TOKEN_${values.length}__`;
    values.push({ placeholder, value: match });
    return placeholder;
  });
  return { text, values };
}

function restoreTranslationValues(value, protectedValues) {
  let restored = String(value || "");
  for (const entry of protectedValues) {
    const occurrences = restored.split(entry.placeholder).length - 1;
    if (occurrences !== 1) throw new Error("Translation changed a protected delivery value.");
    restored = restored.replace(entry.placeholder, entry.value);
  }
  if (PLACEHOLDER.test(restored)) throw new Error("Translation returned an unknown protected delivery value.");
  return restored;
}

function parsedTranslation(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Translation model returned an empty response.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Translation model returned invalid JSON.");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  const text = normalizedText(parsed?.translation);
  if (!text || text.length > MAX_TRANSLATED_TEXT_LENGTH) {
    throw new Error("Translation model returned invalid instruction text.");
  }
  return text;
}

function translationPrompt(text, sourceLanguage, targetLanguage) {
  const target = targetLanguage === "zh-CN" ? "Simplified Chinese" : "clear Canadian English";
  const source = sourceLanguage === "zh-CN" ? "Chinese" : "English";
  return `Translate this delivery instruction from ${source} into ${target}.

Return strict JSON only: {"translation":"..."}

Rules:
1. Preserve meaning and imperative safety details. Do not add advice or explanation.
2. Keep every __MBBS_TOKEN_n__ placeholder exactly once and unchanged.
3. Preserve line breaks where practical.
4. Use concise language suitable for a delivery driver.

DELIVERY INSTRUCTION:
${text}`;
}

async function translateUncached(sourceText, sourceLanguage, targetLanguage, {
  queryFn,
  fetchFn,
  ollamaBaseUrl,
  ollamaModel,
  timeoutMs
}) {
  const sourceHash = crypto.createHash("sha256").update(sourceText).digest("hex");
  const cached = await queryFn(
    `SELECT translated_text, source_language
       FROM delivery_instruction_translation_cache
      WHERE source_hash = $1
        AND target_language = $2
        AND model = $3`,
    [sourceHash, targetLanguage, ollamaModel]
  );
  if (cached.rowCount) {
    return {
      text: String(cached.rows[0].translated_text || sourceText),
      sourceLanguage: normalizeDeliveryInstructionLanguage(cached.rows[0].source_language),
      targetLanguage,
      status: "cached"
    };
  }

  const protectedSource = protectTranslationValues(sourceText);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${ollamaBaseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ollamaModel,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        prompt: translationPrompt(protectedSource.text, sourceLanguage, targetLanguage)
      })
    });
    if (!response?.ok) throw new Error(`Translation model request failed (${response?.status || "unknown"}).`);
    const body = await response.json();
    const translatedText = restoreTranslationValues(
      parsedTranslation(body?.response),
      protectedSource.values
    );
    await queryFn(
      `INSERT INTO delivery_instruction_translation_cache (
         source_hash, target_language, model, source_language, source_text, translated_text,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (source_hash, target_language, model)
       DO UPDATE SET source_language = EXCLUDED.source_language,
                     source_text = EXCLUDED.source_text,
                     translated_text = EXCLUDED.translated_text,
                     updated_at = now()`,
      [sourceHash, targetLanguage, ollamaModel, sourceLanguage, sourceText, translatedText]
    );
    return { text: translatedText, sourceLanguage, targetLanguage, status: "translated" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function translateDeliveryInstructionText(value, targetLanguageValue, options = {}) {
  const sourceText = normalizedText(value);
  const sourceLanguage = detectDeliveryInstructionLanguage(sourceText);
  const targetLanguage = normalizeDeliveryInstructionLanguage(targetLanguageValue);
  if (!sourceText) return { text: "", sourceLanguage, targetLanguage, status: "empty" };
  if (sourceLanguage === targetLanguage) {
    return { text: sourceText, sourceLanguage, targetLanguage, status: "source" };
  }

  const dependencies = {
    queryFn: options.queryFn || query,
    fetchFn: options.fetchFn || globalThis.fetch,
    ollamaBaseUrl: String(options.ollamaBaseUrl || config.ollama.baseUrl).replace(/\/+$/u, ""),
    ollamaModel: String(options.ollamaModel || config.ollama.model),
    timeoutMs: Math.max(100, Number(options.timeoutMs || TRANSLATION_TIMEOUT_MS))
  };
  if (typeof dependencies.fetchFn !== "function") {
    return { text: sourceText, sourceLanguage, targetLanguage, status: "unavailable" };
  }
  const inflightKey = crypto.createHash("sha256")
    .update(`${dependencies.ollamaModel}\n${targetLanguage}\n${sourceText}`)
    .digest("hex");
  if (!translationInflight.has(inflightKey)) {
    translationInflight.set(inflightKey, translateUncached(
      sourceText,
      sourceLanguage,
      targetLanguage,
      dependencies
    ).catch(() => ({
      text: sourceText,
      sourceLanguage,
      targetLanguage,
      status: "unavailable"
    })).finally(() => {
      translationInflight.delete(inflightKey);
    }));
  }
  return translationInflight.get(inflightKey);
}

export async function localizeDeliveryInstructionSet(instructions = {}, targetLanguageValue, options = {}) {
  const targetLanguage = normalizeDeliveryInstructionLanguage(targetLanguageValue);
  const translateFn = options.translateFn || translateDeliveryInstructionText;
  const orders = await Promise.all((Array.isArray(instructions.orders) ? instructions.orders : []).map(async (order) => {
    const [automatic, additional] = await Promise.all([
      translateFn(order?.automaticText || "", targetLanguage, options),
      translateFn(order?.additionalText || "", targetLanguage, options)
    ]);
    return {
      ...order,
      localized: {
        language: targetLanguage,
        automaticText: automatic.text,
        additionalText: additional.text,
        automaticStatus: automatic.status,
        additionalStatus: additional.status
      }
    };
  }));
  return { ...instructions, orders };
}
