/**
 * Util.gs — час, ідентифікатори, хеші, безпечні перетворення.
 * Чиста логіка без звернень до Sheets/Telegram (окрім Utilities).
 */

// ---------- Годинник (ін'єктований у тестах) ----------
function nowMs_() {
  return (typeof __NOW_MS__ === 'number') ? __NOW_MS__ : Date.now();
}
function isoSec_(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function nowIso_() { return isoSec_(nowMs_()); }
function parseIso_(s) {
  if (s === null || s === undefined || s === '') return null;
  const t = Date.parse(String(s));
  return isNaN(t) ? null : t;
}

// ---------- Календарні дні й вікна за часовим поясом (без фіксованого UTC+2/+3) ----------
function tzParts_(ms, tz) {
  const s = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd HH:mm:ss');
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}
function tzOffsetMs_(ms, tz) {
  const p = tzParts_(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function localToUtcMs_(tz, y, mo, d, h, mi, s) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  let t = guess - tzOffsetMs_(guess, tz);
  t = guess - tzOffsetMs_(t, tz);
  return t;
}
/** +n календарних днів із тим самим локальним часом (правильно через перехід на літній/зимовий час). */
function addLocalDays_(ms, n, tz) {
  const p = tzParts_(ms, tz);
  const u = new Date(Date.UTC(p.y, p.mo - 1, p.d + n, p.h, p.mi, p.s));
  return localToUtcMs_(tz, u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds());
}
/** +n календарних місяців із тим самим локальним часом; день обмежується довжиною місяця (31.01 + 1 міс. = 28.02 / 29.02). */
function addLocalMonths_(ms, n, tz) {
  const p = tzParts_(ms, tz);
  const total = p.y * 12 + (p.mo - 1) + n;
  const y = Math.floor(total / 12), mo = (total % 12 + 12) % 12 + 1;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return localToUtcMs_(tz, y, mo, Math.min(p.d, last), p.h, p.mi, p.s);
}
/** Дата, внесена командою вручну: ISO, РРРР-ММ-ДД (північ за часовим поясом) або ДД.ММ.РРРР. null — не розібрано. */
function parseFlexDate_(s, tz) {
  if (s === null || s === undefined || s === '') return null;
  const t = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return localToUtcMs_(tz, +m[1], +m[2], +m[3], 0, 0, 0);
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return localToUtcMs_(tz, +m[3], +m[2], +m[1], 0, 0, 0);
  return parseIso_(t);
}
function localDateStr_(ms, tz) { return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd'); }
function localDateDots_(ms, tz) { return Utilities.formatDate(new Date(ms), tz, 'dd.MM.yyyy'); }
function localDateTimeStr_(ms, tz) { return Utilities.formatDate(new Date(ms), tz, 'dd.MM.yyyy HH:mm'); }

function parseHm_(s, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return fallbackMin;
  const v = (+m[1]) * 60 + (+m[2]);
  return (v >= 0 && v <= 24 * 60) ? v : fallbackMin;
}
/**
 * Найближчий момент у вікні планових повідомлень: початок включно, кінець не включно.
 * Якщо ms уже у вікні — повертає ms.
 */
function nextWindowMs_(ms, tz, startHm, endHm) {
  const startMin = parseHm_(startHm, 600), endMin = parseHm_(endHm, 1200);
  const p = tzParts_(ms, tz);
  const cur = p.h * 60 + p.mi + (p.s > 0 ? 0 : 0);
  if (cur >= startMin && (p.h * 60 + p.mi) < endMin) return ms;
  if (cur < startMin) return localToUtcMs_(tz, p.y, p.mo, p.d, Math.floor(startMin / 60), startMin % 60, 0);
  const u = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return localToUtcMs_(tz, u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate(), Math.floor(startMin / 60), startMin % 60, 0);
}
function inWindow_(ms, tz, startHm, endHm) {
  return nextWindowMs_(ms, tz, startHm, endHm) === ms;
}

// ---------- Ідентифікатори й хеші ----------
function uuid_() { return Utilities.getUuid(); }
function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function sha256Hex_(s) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}
function hmacHex_(message, secret) {
  return hex_(Utilities.computeHmacSha256Signature(String(message), String(secret)));
}
function randomCode_(len) {
  // без неоднозначних символів
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + ':' + Utilities.getUuid(), Utilities.Charset.UTF_8);
  for (let i = 0; i < len; i++) out += alphabet.charAt((bytes[i] & 255) % alphabet.length);
  return out;
}

// ---------- Текст і безпека ----------
function toText_(v) { return (v === null || v === undefined) ? '' : String(v); }
/** Telegram ID / chat_id завжди зберігаємо як текст. */
function idText_(v) { return (v === null || v === undefined || v === '') ? '' : String(v); }
function safeJsonParse_(s, fallback) {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}
function trunc_(s, n) {
  s = toText_(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
/** Прибирає токен бота й схожі секрети з тексту помилок. */
function scrub_(s) {
  s = toText_(s);
  // точне значення токена з Script Properties (найнадійніше), потім загальні шаблони
  try {
    const tok = (typeof propGet_ === 'function') ? propGet_('BOT_TOKEN') : null;
    if (tok && tok.length >= 8) s = s.split(tok).join('***');
  } catch (e) { /* ignore */ }
  return s.replace(/bot\d{5,}:[A-Za-z0-9_-]{8,}/g, 'bot***').replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '***');
}
function normText_(s) {
  return toText_(s).replace(/[’ʼ`]/g, '\'').replace(/\s+/g, ' ').trim();
}
/** Безпечний короткий preview без переносів (для сповіщень і журналів). */
function previewText_(s, n) {
  return trunc_(toText_(s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(), n || 160);
}
function parseList_(s) {
  return toText_(s).split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
}
function chunkText_(text, limit) {
  text = toText_(text);
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}
function isValidEmail_(s) {
  s = toText_(s).trim();
  return s.length <= 254 && /^[^\s@<>()\[\]\\,;:"]+@[^\s@<>()\[\]\\,;:"]+\.[A-Za-z]{2,}$/.test(s);
}
function addQuery_(url, params) {
  const parts = Object.keys(params).filter(function (k) { return params[k] !== null && params[k] !== undefined && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
  if (!parts.length) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
}
function correlationId_() { return 'c' + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

class SafeError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.safe = true; }
}
