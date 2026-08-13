import assert from "node:assert/strict";
import test from "node:test";

import {
  smartScmBlanketMergeProposalIds
} from "../../../src/smart-scm-blanket-repository.js";

function randomGenerator(seed = 0x116758) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

test("Blanket merge selection is deterministic across duplicate-heavy input order", () => {
  const random = randomGenerator();
  for (let example = 0; example < 500; example += 1) {
    const uniqueCount = 2 + Math.floor(random() * 19);
    const base = Array.from({ length: uniqueCount }, (_, index) => 1 + (example * 100) + index);
    const noisy = base.flatMap((id) => random() > 0.45 ? [id, String(id), id] : [String(id)]);
    noisy.push(0, -1, null, undefined, Number.NaN, 1.5);
    const expected = [...base].sort((left, right) => left - right);
    assert.deepEqual(smartScmBlanketMergeProposalIds(shuffled(noisy, random)), expected);
    assert.deepEqual(smartScmBlanketMergeProposalIds(shuffled(noisy, random)), expected);
  }
});

test("Blanket merge selection preserves its hard safety bounds", () => {
  assert.throws(
    () => smartScmBlanketMergeProposalIds([7, "7", 0, -1]),
    (error) => error?.status === 400 && /at least two/i.test(error.message)
  );
  assert.throws(
    () => smartScmBlanketMergeProposalIds(Array.from({ length: 21 }, (_, index) => index + 1)),
    (error) => error?.status === 400 && /no more than 20/i.test(error.message)
  );
});
