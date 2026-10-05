'use strict';

// Answer engine for any OpenAI-compatible chat-completions endpoint.
// Works with OpenAI, but also local servers (Ollama, LM Studio, llama.cpp) via
// OPENAI_BASE_URL, e.g. http://localhost:11434/v1 for Ollama.

const { extractJson, normalizeLetters, buildPrompt } = require('./util');

const DEFAULT_MODEL = process.env.ORACLE_QUIZ_OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

async function answerOne(opts) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const model = opts.model || DEFAULT_MODEL;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  else if (/api\.openai\.com/.test(base)) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You answer multiple-choice questions and reply with JSON only.' },
        { role: 'user', content: buildPrompt(opts) }
      ],
      response_format: { type: 'json_object' }
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI-compatible API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const text =
    json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) throw new Error('Model returned an empty response.');

  return normalizeLetters(extractJson(text), opts.choices.length);
}

module.exports = { answerOne, DEFAULT_MODEL, DEFAULT_BASE };
