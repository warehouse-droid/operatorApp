import assert from "node:assert/strict";
import test from "node:test";

import {
  detectDeliveryInstructionLanguage,
  localizeDeliveryInstructionSet,
  normalizeDeliveryInstructionLanguage,
  translateDeliveryInstructionText
} from "../../../src/delivery-instruction-translation.js";

test("delivery-instruction language normalization and detection are strict", () => {
  assert.equal(normalizeDeliveryInstructionLanguage("zh-cn"), "zh-CN");
  assert.equal(normalizeDeliveryInstructionLanguage("en-CA"), "en");
  assert.equal(normalizeDeliveryInstructionLanguage("fr"), "en");
  assert.equal(detectDeliveryInstructionLanguage("Leave pallets beside gate 7."), "en");
  assert.equal(detectDeliveryInstructionLanguage("请把托盘放在 7 号门旁。"), "zh-CN");
});

test("same-language text returns immediately without a database or model call", async () => {
  let calls = 0;
  const result = await translateDeliveryInstructionText("请先致电客户。", "zh-CN", {
    queryFn: async () => { calls += 1; },
    fetchFn: async () => { calls += 1; }
  });
  assert.deepEqual(result, {
    text: "请先致电客户。",
    sourceLanguage: "zh-CN",
    targetLanguage: "zh-CN",
    status: "source"
  });
  assert.equal(calls, 0);
});

test("a cache miss uses local Ollama once, preserves protected values, and writes the cache", async () => {
  const queries = [];
  const requests = [];
  const queryFn = async (sql, params) => {
    queries.push({ sql, params });
    if (/^\s*SELECT/u.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };
  const fetchFn = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      async json() {
        return { response: JSON.stringify({ translation: "将托盘放在 __MBBS_TOKEN_0__ 号门旁。" }) };
      }
    };
  };

  const result = await translateDeliveryInstructionText("Leave pallets beside gate 7.", "zh-CN", {
    queryFn,
    fetchFn,
    ollamaBaseUrl: "http://ollama:11434",
    ollamaModel: "test-model",
    timeoutMs: 1000
  });

  assert.deepEqual(result, {
    text: "将托盘放在 7 号门旁。",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    status: "translated"
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://ollama:11434/api/generate");
  assert.match(String(requests[0].options.body), /__MBBS_TOKEN_0__/u);
  assert.equal(queries.filter(({ sql }) => /INSERT INTO delivery_instruction_translation_cache/u.test(sql)).length, 1);
});

test("cached translations bypass Ollama and model failure safely falls back to source", async () => {
  let fetchCalls = 0;
  const cached = await translateDeliveryInstructionText("Call before delivery.", "zh-CN", {
    queryFn: async () => ({
      rowCount: 1,
      rows: [{ translated_text: "送货前请致电。", source_language: "en" }]
    }),
    fetchFn: async () => { fetchCalls += 1; }
  });
  assert.equal(cached.text, "送货前请致电。");
  assert.equal(cached.status, "cached");
  assert.equal(fetchCalls, 0);

  const fallback = await translateDeliveryInstructionText("Use the east gate.", "zh-CN", {
    queryFn: async () => ({ rowCount: 0, rows: [] }),
    fetchFn: async () => { throw new Error("offline"); },
    timeoutMs: 20
  });
  assert.equal(fallback.text, "Use the east gate.");
  assert.equal(fallback.status, "unavailable");
});

test("a Driver instruction set localizes both text fields without changing orders or media", async () => {
  const source = {
    revision: 4,
    orders: [{
      orderId: 123,
      orderRef: "SOB123",
      automaticText: "Call before delivery.",
      additionalText: "Place beside garage.",
      media: [{ id: "media-1" }]
    }]
  };
  const translations = new Map([
    ["Call before delivery.", "送货前请致电。"],
    ["Place beside garage.", "放在车库旁。"]
  ]);
  const localized = await localizeDeliveryInstructionSet(source, "zh-CN", {
    translateFn: async (text, targetLanguage) => ({
      text: translations.get(text),
      sourceLanguage: "en",
      targetLanguage,
      status: "translated"
    })
  });

  assert.equal(localized.revision, 4);
  assert.deepEqual(localized.orders[0].media, [{ id: "media-1" }]);
  assert.deepEqual(localized.orders[0].localized, {
    language: "zh-CN",
    automaticText: "送货前请致电。",
    additionalText: "放在车库旁。",
    automaticStatus: "translated",
    additionalStatus: "translated"
  });
});
