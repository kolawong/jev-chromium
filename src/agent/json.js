class StructuredOutputError extends Error {
  constructor(reason = 'Return exactly one complete JSON object, without extra objects or commentary.') {
    super('云端模型结构化内容连续格式无效，已保留结果；可以稍后继续重试');
    this.name = 'StructuredOutputError';
    this.code = 'MODEL_FORMAT_INVALID';
    this.reason = reason;
  }
}
/** Accept one complete JSON object with optional model prose/fences, never partial JSON. */
function parseJsonObject(text) {
  const raw = String(text || '').split('</think>').pop().trim();
  const start = raw.indexOf('{');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; start >= 0 && i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const suffix = raw.slice(i + 1).replace(/```/g, '').trim();
      if (/[{}\[\]]/.test(suffix)) break; // ambiguous extra JSON must be retried
      try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; }
    }
  }
  throw new StructuredOutputError();
}
module.exports = { parseJsonObject, StructuredOutputError };
