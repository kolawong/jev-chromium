const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../../.env');

function parseEnv(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) map.set(key, value);
  }
  return map;
}

function serializeEnv(map, preferredOrder = []) {
  const seen = new Set();
  const out = [];
  for (const key of preferredOrder) {
    if (!map.has(key)) continue;
    out.push(`${key}=${map.get(key)}`);
    seen.add(key);
  }
  for (const [key, value] of map.entries()) {
    if (seen.has(key)) continue;
    out.push(`${key}=${value}`);
  }
  if (out.length === 0 || out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}

/**
 * Merge keys into .env without dropping unrelated variables.
 */
function upsertEnvVars(updates, preferredOrder = [
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'TEXT_MODEL_API_KEY',
  'TEXT_MODEL_BASE_URL',
  'TEXT_MODEL',
  'TEXT_MODEL_REASONING',
]) {
  let existing = '';
  try {
    existing = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const map = parseEnv(existing);
  for (const [key, value] of Object.entries(updates || {})) {
    if (value === undefined || value === null) continue;
    map.set(key, String(value));
  }
  // Keep a short comment block for known helper section if writing fresh file
  const body = serializeEnv(map, preferredOrder);
  const header = existing.includes('TEXT_MODEL')
    ? ''
    : '# Helper LLM for TYPE_TEXT text generation is TEXT_MODEL_*\n';
  fs.writeFileSync(ENV_PATH, header + body, 'utf8');
  return ENV_PATH;
}

module.exports = { ENV_PATH, parseEnv, serializeEnv, upsertEnvVars };
