'use strict';

// Text redaction for the shareable/sanitized export. The recording pipeline already
// keeps raw paths out of events (probes emit only classes, statuses and numbers), so
// this is defence in depth for any free-form string that could still carry personal
// data — an error class that embeds a message, a stray label, a future field. Applied
// only when producing the sanitized artefacts, never to the local-only private map.

// Order matters: data URIs and tokens are matched before generic paths so their inner
// slashes are not half-replaced.
const RULES = [
  // data: URIs (may be huge base64 thumbnails) → single placeholder
  [/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;[a-z0-9=]+,[^\s"']+/gi, '<data-uri>'],
  // key=value secrets (api_key, token, user_id, password, apikey, access_token, ...)
  [/\b(?:api[_-]?key|apikey|token|access[_-]?token|user[_-]?id|password|secret|auth)\b\s*[=:]\s*[^\s"'&]+/gi, '<token>'],
  // emails
  [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '<email>'],
  // Windows drive paths: C:\Users\alex\... or C:/Users/alex/... The lookbehind keeps
  // it from matching the "s:/" inside "https://".
  [/(?<![a-z0-9])[a-z]:[\\/][^\s"'<>|?*]+/gi, '<path>'],
  // UNC paths: \\server\share\...
  [/\\\\[^\s"'<>|?*]+/g, '<path>'],
  // POSIX home / absolute user paths
  [/\/(?:home|Users)\/[^\s"'<>|?*]+/g, '<path>'],
  // URL query strings (?a=b&c=d) → keep the base, drop the query
  [/\?[^\s"'<>#]+/g, '<query>'],
];

function redactText(value) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

// Deep-redact a JSON-safe value (strings inside objects/arrays). Non-strings pass through.
function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = redactValue(v);
    return out;
  }
  return value;
}

// True if a string still looks like it contains personal data after redaction — used
// by tests/self-checks to assert the sanitized export is clean.
function looksSensitive(value) {
  if (typeof value !== 'string') return false;
  return /[a-z]:[\\/]|\\\\[^\s]|\/(?:home|Users)\/|@[a-z0-9.-]+\.[a-z]{2,}/i.test(value);
}

module.exports = {
  redactText,
  redactValue,
  looksSensitive,
};
