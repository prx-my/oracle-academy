'use strict';

// Shared helpers for answer providers.

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Could not parse model response: ${String(text).slice(0, 200)}`);
    return JSON.parse(m[0]);
  }
}

/** Normalize a model's {"answer":["b"]} response into validated option letters. */
function normalizeLetters(obj, count) {
  const raw = obj && (obj.answer !== undefined ? obj.answer : obj.answers);
  let arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  arr = arr
    .map((x) => String(x).toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
  const valid = arr.filter((l) => l.length === 1 && l.charCodeAt(0) - 97 < count);
  if (!valid.length) {
    throw new Error(`Model returned no valid option letters (choices=${count}).`);
  }
  return [...new Set(valid)];
}

function buildPrompt({ question, choices, multiple }) {
  const header = multiple
    ? 'Answer this Oracle Academy multiple-select question. Choose ALL correct options.'
    : 'Answer this Oracle Academy multiple-choice question. Choose exactly ONE correct option.';
  return [
    header,
    'Return ONLY minified JSON of the form {"answer":["b"]} — the letters of the correct option(s).',
    '',
    question,
    '',
    ...choices.map((c, i) => `${String.fromCharCode(97 + i)}) ${c}`)
  ].join('\n');
}

module.exports = { extractJson, normalizeLetters, buildPrompt };
