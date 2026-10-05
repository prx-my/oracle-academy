'use strict';

const gemini = require('./gemini');
const openai = require('./openai');

/**
 * Resolve an answer provider.
 *  - "gemini" : Gemini API (GEMINI_API_KEY / GOOGLE_API_KEY)
 *  - "openai" : any OpenAI-compatible endpoint (OPENAI_API_KEY / OPENAI_BASE_URL)
 *  - "none"   : no engine; answers must be supplied by the caller (agent-driven)
 */
function getAnswerProvider(name) {
  const key = String(name || '').toLowerCase();
  switch (key) {
    case 'gemini':
      return gemini;
    case 'openai':
    case 'local':
      return openai;
    case 'none':
    case 'manual':
    case 'opencode':
      return null;
    default:
      throw new Error(`Unknown provider "${name}". Use one of: gemini, openai, none.`);
  }
}

module.exports = { getAnswerProvider };
