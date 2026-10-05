'use strict';

// Answer engine backed by the Gemini API (BYO key). One request per question,
// since the assessment shows one question at a time.

const { extractJson, normalizeLetters, buildPrompt } = require('./util');

const DEFAULT_MODEL = process.env.ORACLE_QUIZ_GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

async function answerOne(opts) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.');
  const model = opts.model || DEFAULT_MODEL;

  const url = `${ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(opts) }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 256,
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const text =
    json &&
    json.candidates &&
    json.candidates[0] &&
    json.candidates[0].content &&
    json.candidates[0].content.parts &&
    json.candidates[0].content.parts.map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned an empty response.');

  return normalizeLetters(extractJson(text), opts.choices.length);
}

module.exports = { answerOne, DEFAULT_MODEL };
