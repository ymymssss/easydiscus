function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function safeText(value, minLen, maxLen) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s.length < minLen) return null;
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function isValidUsername(username) {
  // ASCII-ish usernames for portability.
  return /^[a-zA-Z0-9_]{2,24}$/.test(username);
}

function normalizeTag(tag) {
  const t = String(tag || "").trim().toLowerCase();
  if (!t) return "";
  const cleaned = t.replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return cleaned;
}

function splitTags(tags) {
  if (!tags) return [];
  let list = [];
  if (Array.isArray(tags)) list = tags;
  else list = String(tags).split(/[ ,]+/g);

  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const t = normalizeTag(raw);
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return "";
  const allowed = new Set(["open", "in_progress", "blocked", "done", "closed"]);
  return allowed.has(s) ? s : "";
}

function normalizeKind(kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (!k) return "";
  const allowed = new Set(["post", "task"]);
  return allowed.has(k) ? k : "";
}

function parseBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v || "").trim().toLowerCase();
  if (!s) return false;
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

module.exports = {
  clamp,
  safeText,
  isValidUsername,
  normalizeTag,
  normalizeStatus,
  normalizeKind,
  parseBool,
  splitTags,
};
