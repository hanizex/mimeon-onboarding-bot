/**
 * Attachments.gs — вкладення учасників і безпечний переглядач для команди.
 *
 *  - Таблиця "Вкладення" зберігає лише метадані й file_id (сам файл лишається на серверах Telegram).
 *  - Команда відкриває файл за ПІДПИСАНИМ посиланням: /exec?a=<id>&v=<версія>&e=<до>&t=<HMAC>.
 *    Підпис = HMAC-SHA256(VIEWER_SIGNING_SECRET, "id:версія:до"). Секрет лише у Script Properties.
 *  - doGet — єдина публічна точка входу веб-застосунку. Вона нічого не змінює й нікому нічого не надсилає.
 *  - Файл завантажується сервером із фіксованого хосту Telegram, токен бота ніколи не потрапляє у браузер.
 *  - Показ: лише білий список типів (зображення, відео, аудіо, простий текст). HTML/SVG/скрипти — лише
 *    як завантаження (octet-stream), ніколи не виконуються.
 */

// MIME, які дозволено показувати "на сторінці". Усе інше — лише завантаження.
const VIEWER_INLINE = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/webm': 'video', 'video/quicktime': 'video',
  'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio', 'audio/wav': 'audio', 'audio/webm': 'audio', 'audio/x-wav': 'audio',
  'text/plain': 'text'
};
const VIEWER_EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  txt: 'text/plain'
};
const VIEWER_TEXT_MAX_CHARS = 200000;

function attachments_() {
  const t = table_('ATTACHMENTS');
  if (!t.loaded) t.load(3);
  return t;
}

function attIdFor_(eventId, index) {
  return 'att_' + sha256Hex_('att|' + eventId + '|' + index).slice(0, 16);
}

/** Межа розміру: налаштування команди, але не більше 20 МБ (стеля Bot API для getFile). */
function viewerMaxBytes_(S) {
  return Math.min(S.FILE_VIEWER_MAX_BYTES || 10000000, TG_DOWNLOAD_LIMIT_BYTES);
}

/** ok | too_large | viewer_not_configured. Невідомий розмір не вважається завеликим. */
function attachmentPreviewStatus_(sizeBytes, S) {
  if (sizeBytes && sizeBytes > viewerMaxBytes_(S)) return 'too_large';
  if (!S.FILE_VIEWER_BASE_URL) return 'viewer_not_configured';
  return 'ok';
}

// ---------- Підписані посилання ----------
function viewerSign_(id, version, expMs) {
  const secret = propGet_(PROP.VIEWER_SIGNING_SECRET);
  if (!secret) throw new SafeError('no_viewer_secret', 'Немає VIEWER_SIGNING_SECRET. Запустіть bootstrap_().');
  return hmacHex_(id + ':' + version + ':' + expMs, secret);
}
function viewerUrl_(id, version, S, nowMs) {
  const exp = nowMs + S.VIEWER_URL_TTL_HOURS * 3600000;
  const url = addQuery_(S.FILE_VIEWER_BASE_URL, { a: id, v: version, e: exp, t: viewerSign_(id, version, exp) });
  return { url: url, expiresIso: isoSec_(exp) };
}
function constEq_(a, b) {
  a = toText_(a); b = toText_(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- Запис вкладень повідомлення (ідемпотентно за event_id + індекс) ----------
/** Повертає масив рядків вкладень (нових і вже наявних). */
function recordAttachments_(p, ev, m, msgRecordId, ticketId) {
  const list = (m && m.attachments) || [];
  if (!list.length) return [];
  const S = settings_();
  const tbl = attachments_();
  const out = [];
  const fresh = [];
  const nowMs = nowMs_();
  list.forEach(function (a, i) {
    const id = attIdFor_(ev.event_id, i);
    const ex = tbl.get(id);
    if (ex) { out.push(ex); return; }
    const status = attachmentPreviewStatus_(a.file_size, S);
    const row = {
      attachment_id: id, participant_id: p.participant_id, message_record_id: msgRecordId, ticket_id: ticketId || null, survey_id: null,
      file_id: a.file_id, file_unique_id: a.file_unique_id || null, media_type: a.type, mime_type: a.mime_type || null,
      file_name: a.file_name || null, file_size_bytes: a.file_size || null, caption: m.caption || null, media_group_id: m.media_group_id || null,
      viewer_token_version: 1, viewer_url: null, viewer_expires_at: null, preview_status: status
    };
    if (status === 'ok') { const v = viewerUrl_(id, 1, S, nowMs); row.viewer_url = v.url; row.viewer_expires_at = v.expiresIso; }
    fresh.push(row);
    out.push(row);
  });
  if (fresh.length) {
    const created = tbl.appendMany(fresh);
    // у out замінюємо чорнові об'єкти на створені (з _row)
    created.forEach(function (c) { for (let i = 0; i < out.length; i++) if (out[i].attachment_id === c.attachment_id) out[i] = c; });
  }
  return out;
}

/** Прив'язує вкладення повідомлення до звернення (повідомлення могло спершу лишитися без звернення). */
function linkAttachmentsToTicket_(attachmentIdsCsv, ticketId) {
  const ids = parseList_(attachmentIdsCsv);
  if (!ids.length) return;
  const tbl = attachments_();
  ids.forEach(function (id) {
    const a = tbl.get(id);
    if (a && a.ticket_id !== ticketId) tbl.update(a, { ticket_id: ticketId });
  });
}

/** Чи був хоч один вкладений файл завеликим для перегляду (для відповіді учаснику). */
function oversizedAttachmentMb_(attachments, S) {
  const limit = viewerMaxBytes_(S);
  const big = (attachments || []).some(function (a) { return a.file_size && a.file_size > limit; });
  return big ? Math.floor(limit / 1000000) : 0;
}

// ---------- Обслуговування посилань (раз на ~30 хв) ----------
function viewerHousekeeping_(S) {
  const last = parseIso_(propGet_(PROP.VIEWER_HK_AT));
  const now = nowMs_();
  if (last !== null && now - last < 30 * 60000) return;
  const tbl = attachments_();
  const ttl = S.VIEWER_URL_TTL_HOURS * 3600000;
  let done = 0;
  tbl.rows.forEach(function (a) {
    if (done >= 100) return;
    const expiresMs = parseIso_(a.viewer_expires_at);
    const status = attachmentPreviewStatus_(a.file_size_bytes, S);
    const base = S.FILE_VIEWER_BASE_URL;
    if (status !== 'ok') {
      if (a.preview_status !== status || a.viewer_url) { tbl.update(a, { preview_status: status, viewer_url: null, viewer_expires_at: null }); done++; }
      return;
    }
    const stale = !a.viewer_url || expiresMs === null || (expiresMs - now) < ttl / 2 || a.viewer_url.indexOf(base) !== 0;
    if (!stale) return;
    const v = viewerUrl_(a.attachment_id, a.viewer_token_version || 1, S, now);
    tbl.update(a, { preview_status: 'ok', viewer_url: v.url, viewer_expires_at: v.expiresIso });
    done++;
  });
  propSet_(PROP.VIEWER_HK_AT, isoSec_(now));
}

/** Аварійне скасування всіх виданих посилань: підвищує версію, наступне обслуговування видасть нові. */
function revokeViewerLinks_() {
  const tbl = attachments_();
  tbl.rows.forEach(function (a) {
    tbl.update(a, { viewer_token_version: (a.viewer_token_version || 1) + 1, viewer_url: null, viewer_expires_at: null });
  });
  propDelete_(PROP.VIEWER_HK_AT);
  return tbl.rows.length;
}

// ---------- Веб-застосунок: перегляд вкладення ----------
function doGet(e) {
  resetCtx_();
  let model;
  try {
    model = viewerModel_((e && e.parameter) || {});
  } catch (err) {
    try { Logger.log('viewer_error: ' + scrub_(err && err.message)); } catch (x) { /* ignore */ }
    model = { kind: 'error', title: 'Не вдалося відкрити вкладення', note: 'Спробуйте пізніше або попросіть команду перевірити налаштування переглядача.' };
  }
  return viewerHtml_(model);
}

function viewerHtml_(model) {
  const tpl = HtmlService.createTemplateFromFile('Viewer');
  tpl.model = model;
  return tpl.evaluate().setTitle('Вкладення Mimeon');
}

function viewerInvalid_() {
  // одна й та сама відповідь для всіх причин: не підказуємо, що саме не так (підпис, строк, версія, видалені дані)
  return { kind: 'error', title: 'Посилання недійсне або застаріло', note: 'Попросіть оновлене посилання в таблиці (воно оновлюється автоматично).' };
}

function viewerMime_(att, filePath) {
  let mime = toText_(att.mime_type).toLowerCase().split(';')[0].trim();
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(toText_(filePath));
  const ext = m ? m[1].toLowerCase() : '';
  if (!mime) mime = VIEWER_EXT_MIME[ext] || '';
  if (!mime) {
    if (att.media_type === 'photo') mime = 'image/jpeg';
    else if (att.media_type === 'voice') mime = 'audio/ogg';
    else if (att.media_type === 'video_note' || att.media_type === 'animation') mime = 'video/mp4';
  }
  return mime;
}

function viewerModel_(params) {
  const id = toText_(params.a);
  const v = Number(params.v), exp = Number(params.e);
  const tok = toText_(params.t);
  if (!/^att_[0-9a-f]{16}$/.test(id) || !isFinite(v) || !isFinite(exp) || !/^[0-9a-f]{64}$/.test(tok)) return viewerInvalid_();
  if (!propGet_(PROP.VIEWER_SIGNING_SECRET)) return viewerInvalid_();
  if (!constEq_(viewerSign_(id, v, exp), tok)) return viewerInvalid_();
  if (nowMs_() > exp) return viewerInvalid_();
  const att = attachments_().get(id);
  if (!att) return viewerInvalid_();
  if ((att.viewer_token_version || 1) !== v) return viewerInvalid_();

  const S = settings_();
  const max = viewerMaxBytes_(S);
  const meta = {
    ticket: att.ticket_id || '—', type: att.media_type || '—', name: att.file_name || '—',
    size: att.file_size_bytes ? formatBytes_(att.file_size_bytes) : 'невідомо', caption: att.caption || ''
  };
  if (att.file_size_bytes && att.file_size_bytes > max) {
    return { kind: 'too_large', title: 'Файл завеликий для перегляду', note: 'Ліміт перегляду ' + formatBytes_(max) + '. Метадані збережені в таблиці; попросіть учасника надіслати коротшу версію.', meta: meta };
  }
  const gf = tgGetFile_(att.file_id);
  if (!gf.ok || !gf.result || !gf.result.file_path) {
    return { kind: 'error', title: 'Файл недоступний', note: 'Telegram не віддав файл (він міг бути видалений або завеликий). Метадані: див. нижче.', meta: meta };
  }
  if (gf.result.file_size && gf.result.file_size > max) {
    return { kind: 'too_large', title: 'Файл завеликий для перегляду', note: 'Ліміт перегляду ' + formatBytes_(max) + '.', meta: meta };
  }
  const dl = tgDownload_(gf.result.file_path);
  if (!dl.ok) return { kind: 'error', title: 'Не вдалося завантажити файл', note: 'Спробуйте ще раз за хвилину.', meta: meta };
  const bytes = dl.bytes;
  if (bytes.length > max) return { kind: 'too_large', title: 'Файл завеликий для перегляду', note: 'Ліміт перегляду ' + formatBytes_(max) + '.', meta: meta };

  const mime = viewerMime_(att, gf.result.file_path);
  const kind = VIEWER_INLINE[mime] || null;
  const model = { kind: kind || 'download', title: 'Вкладення ' + att.attachment_id, note: '', meta: meta, mime: kind ? mime : 'application/octet-stream' };
  if (kind === 'text') {
    model.text = Utilities.newBlob(bytes).getDataAsString('UTF-8').slice(0, VIEWER_TEXT_MAX_CHARS);
  } else {
    model.b64 = Utilities.base64Encode(bytes);
  }
  if (!kind) {
    model.note = 'Цей тип файла не відкривається на сторінці з міркувань безпеки. Його можна лише завантажити; відкривайте, лише якщо довіряєте джерелу.';
    model.filename = att.file_name || (att.attachment_id + '.bin');
  }
  return model;
}

function formatBytes_(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return (Math.round(n / 102.4) / 10) + ' КБ';
  return (Math.round(n / 104857.6) / 10) + ' МБ';
}
