/**
 * Telegram.gs — обгортка Telegram Bot API.
 * Лише api.telegram.org, лише вбудовані методи. Токен не потрапляє в журнали, таблиці чи HTML.
 *
 * Результат виклику tgCall_():
 *  {ok:true, kind:'ok', result}
 *  {ok:false, kind:'retry', retryAfter, description}      — 429 або 5xx з підтвердженою відмовою Telegram
 *  {ok:false, kind:'blocked'}                              — 403: бота заблоковано / користувач деактивований
 *  {ok:false, kind:'permanent'}                            — 400/404: запит не можна виконати повторенням
 *  {ok:false, kind:'unauthorized'|'conflict'}              — 401 (токен) / 409 (webhook або інший getUpdates)
 *  {ok:false, kind:'unknown'}                              — таймаут/обрив/нерозпізнана відповідь: запит МІГ бути прийнятий
 */

function tgToken_() {
  const t = propGet_(PROP.BOT_TOKEN);
  if (!t) throw new SafeError('no_token', 'Не задано BOT_TOKEN у Script Properties.');
  return t;
}

function tgCall_(method, payload) {
  const token = tgToken_();
  const url = TG_API_HOST + '/bot' + token + '/' + method;
  G().metrics.apiCalls++;
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, kind: 'unknown', status: 0, description: scrub_(e && e.message) };
  }
  const status = resp.getResponseCode();
  const body = safeJsonParse_(resp.getContentText(), null);
  if (!body || typeof body.ok !== 'boolean') {
    return { ok: false, kind: 'unknown', status: status, description: 'нерозпізнана відповідь Telegram (HTTP ' + status + ')' };
  }
  if (body.ok) return { ok: true, kind: 'ok', status: status, result: body.result };
  const code = body.error_code || status;
  const desc = scrub_(body.description || '');
  const retryAfter = (body.parameters && body.parameters.retry_after) ? Number(body.parameters.retry_after) : null;
  let kind = 'permanent';
  if (code === 429) kind = 'retry';
  else if (code >= 500) kind = 'retry';
  else if (code === 403) kind = 'blocked';
  else if (code === 401) kind = 'unauthorized';
  else if (code === 409) kind = 'conflict';
  return { ok: false, kind: kind, status: status, errorCode: code, description: desc, retryAfter: retryAfter };
}

function tgGetMe_() { return tgCall_('getMe', {}); }
function tgGetWebhookInfo_() { return tgCall_('getWebhookInfo', {}); }
/** Свідомо без drop_pending_updates: непрочитані повідомлення зберігаються. */
function tgDeleteWebhookKeepUpdates_() { return tgCall_('deleteWebhook', { drop_pending_updates: false }); }

function tgGetUpdates_(offset, limit, timeoutSec) {
  const p = { limit: limit || 100, timeout: (timeoutSec === undefined || timeoutSec === null) ? 1 : timeoutSec, allowed_updates: TG_ALLOWED_UPDATES };
  if (offset !== null && offset !== undefined) p.offset = offset;
  return tgCall_('getUpdates', p);
}

/** Лише дозволені поля; chat_id завжди береться з завдання, а не з довільного payload. */
function tgSendMessage_(chatId, payload) {
  const p = { chat_id: chatId, text: toText_(payload.text) };
  if (payload.reply_markup) p.reply_markup = payload.reply_markup;
  if (payload.disable_web_page_preview) p.disable_web_page_preview = true;
  if (payload.reply_to_message_id) p.reply_to_message_id = payload.reply_to_message_id;
  return tgCall_('sendMessage', p);
}

/** Дозволені методи надсилання медіа: тип вкладення -> {method, field, caption}. Жодних інших методів. */
const TG_MEDIA_METHODS = {
  photo: { method: 'sendPhoto', field: 'photo', caption: true },
  video: { method: 'sendVideo', field: 'video', caption: true },
  voice: { method: 'sendVoice', field: 'voice', caption: true },
  audio: { method: 'sendAudio', field: 'audio', caption: true },
  document: { method: 'sendDocument', field: 'document', caption: true },
  animation: { method: 'sendAnimation', field: 'animation', caption: true },
  video_note: { method: 'sendVideoNote', field: 'video_note', caption: false },
  sticker: { method: 'sendSticker', field: 'sticker', caption: false }
};
const TG_CAPTION_LIMIT = 1024;
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;   // Bot API віддає боту файли лише до 20 МБ

/** Єдина точка відправки завдання з черги: текст або медіа за file_id. chat_id — лише з завдання. */
function tgSendPayload_(chatId, payload) {
  const m = payload.method || 'sendMessage';
  if (m === 'sendMessage') return tgSendMessage_(chatId, payload);
  const def = TG_MEDIA_METHODS[payload.media_type];
  if (!def || def.method !== m || !payload.file_id) return { ok: false, kind: 'permanent', errorCode: 400, description: 'недозволений медіа-метод або немає file_id' };
  const p = { chat_id: chatId };
  p[def.field] = payload.file_id;
  if (def.caption && payload.caption) p.caption = trunc_(payload.caption, TG_CAPTION_LIMIT);
  if (payload.reply_markup) p.reply_markup = payload.reply_markup;
  return tgCall_(m, p);
}

function tgGetFile_(fileId) { return tgCall_('getFile', { file_id: fileId }); }

/** Завантаження файла Telegram. Лише фіксований хост; шлях перевіряється. Повертає {ok, bytes} або {ok:false, kind}. */
function tgDownload_(filePath) {
  const path = toText_(filePath);
  if (!/^[A-Za-z0-9_\-.\/]{1,300}$/.test(path) || path.indexOf('..') >= 0) return { ok: false, kind: 'bad_path' };
  let resp;
  try {
    resp = UrlFetchApp.fetch(TG_API_HOST + '/file/bot' + tgToken_() + '/' + path, { method: 'get', muteHttpExceptions: true });
  } catch (e) {
    return { ok: false, kind: 'unknown', description: scrub_(e && e.message) };
  }
  const code = resp.getResponseCode();
  if (code !== 200) return { ok: false, kind: 'http', status: code };
  return { ok: true, bytes: resp.getContent() };
}

// ---------- Клавіатури ----------
/**
 * Пакує підписи кнопок у рядки. На комп'ютері кнопка в рядку розтягується на всю ширину, тому «одна кнопка — один рядок»
 * виглядає громіздко й швидко виходить за видиму частину клавіатури. Правило: до 3 кнопок у рядку, сумарно до 34 символів.
 */
const KB_ROW_MAX_BUTTONS = 3;
const KB_ROW_MAX_CHARS = 34;
function packRows_(labels, maxPerRow, maxChars) {
  maxPerRow = maxPerRow || KB_ROW_MAX_BUTTONS;
  maxChars = maxChars || KB_ROW_MAX_CHARS;
  const rows = [];
  let cur = [], len = 0;
  labels.forEach(function (l) {
    const n = String(l).length;
    if (cur.length && (cur.length >= maxPerRow || len + n > maxChars)) { rows.push(cur); cur = []; len = 0; }
    cur.push(l); len += n;
  });
  if (cur.length) rows.push(cur);
  return rows;
}
/** Сусідні рядки з однієї кнопки об'єднує за правилом packRows_; рядки, які вже складені вручну, не чіпає. */
function packSingleRows_(rows) {
  const out = [];
  let group = [];
  const flush = function () { if (group.length) { packRows_(group).forEach(function (r) { out.push(r); }); group = []; } };
  rows.forEach(function (r) {
    if (r.length === 1) group.push(r[0]);
    else { flush(); out.push(r); }
  });
  flush();
  return out;
}

function kbReply_(rows, opts) {
  opts = opts || {};
  const laid = opts.pack === false ? rows : packSingleRows_(rows);
  const kb = { keyboard: laid.map(function (r) { return r.map(function (t) { return { text: t }; }); }), resize_keyboard: true };
  if (opts.oneTime) kb.one_time_keyboard = true;
  if (opts.placeholder) kb.input_field_placeholder = opts.placeholder;
  return kb;
}
function kbRemove_() { return { remove_keyboard: true }; }
function kbForceReply_(placeholder) {
  const f = { force_reply: true };
  if (placeholder) f.input_field_placeholder = placeholder;
  return f;
}
function kbInlineUrls_(buttons) {
  return { inline_keyboard: buttons.map(function (b) { return [{ text: b[0], url: b[1] }]; }) };
}
function mainMenuKb_() {
  return kbReply_([
    [BTN.MENU_MEMO, BTN.MENU_GUIDE, BTN.MENU_DATA],
    [BTN.MENU_SUPPORT, BTN.MENU_CRITICAL],
    [BTN.MENU_FEEDBACK, BTN.MENU_REWARD]
  ]);
}

// ---------- Нормалізація update ----------
function extractAttachments_(m) {
  const out = [];
  function add(type, o) {
    out.push({
      type: type, file_id: o.file_id, file_unique_id: o.file_unique_id,
      file_size: o.file_size || null, mime_type: o.mime_type || null, file_name: o.file_name || null,
      duration: o.duration || null, width: o.width || null, height: o.height || null
    });
  }
  if (m.photo && m.photo.length) {
    let best = m.photo[0];
    m.photo.forEach(function (p) { if ((p.file_size || 0) >= (best.file_size || 0)) best = p; });
    add('photo', best);
  }
  ['video', 'voice', 'audio', 'document', 'video_note', 'animation', 'sticker'].forEach(function (t) { if (m[t]) add(t, m[t]); });
  return out;
}

function fromUser_(u) {
  if (!u) return null;
  return { id: idText_(u.id), is_bot: !!u.is_bot, first_name: u.first_name || null, last_name: u.last_name || null,
    username: u.username || null, language_code: u.language_code || null, is_premium: u.is_premium === true ? true : null };
}

/**
 * Нормалізує update у мінімальний payload. Не копіює forwarded/replied профілі.
 * Код прив'язки власника редагується ДО запису в Inbox.
 */
function normalizeUpdate_(u) {
  const base = { update_id: u.update_id };
  const m = u.message || u.edited_message;
  if (m) {
    const kind = u.message ? 'message' : 'edited_message';
    let text = m.text !== undefined ? m.text : null;
    if (text && /^\/bind_owner(@\w+)?(\s|$)/i.test(text)) text = text.replace(/^(\/bind_owner(@\w+)?)\s+.*$/is, '$1 [REDACTED]');
    const payload = {
      update_id: u.update_id, kind: kind,
      chat: { id: idText_(m.chat && m.chat.id), type: m.chat && m.chat.type },
      from: fromUser_(m.from),
      message: {
        message_id: idText_(m.message_id), date: m.date || null, edit_date: m.edit_date || null,
        text: text, caption: m.caption !== undefined ? m.caption : null,
        reply_to_message_id: m.reply_to_message ? idText_(m.reply_to_message.message_id) : null,
        media_group_id: m.media_group_id ? idText_(m.media_group_id) : null,
        attachments: extractAttachments_(m)
      }
    };
    return { eventType: kind, userId: idText_(m.from && m.from.id), chatId: idText_(m.chat && m.chat.id), payload: payload };
  }
  if (u.my_chat_member) {
    const c = u.my_chat_member;
    const payload = {
      update_id: u.update_id, kind: 'my_chat_member',
      chat: { id: idText_(c.chat && c.chat.id), type: c.chat && c.chat.type },
      from: fromUser_(c.from),
      my_chat_member: { old_status: c.old_chat_member && c.old_chat_member.status, new_status: c.new_chat_member && c.new_chat_member.status, date: c.date || null }
    };
    return { eventType: 'my_chat_member', userId: idText_(c.from && c.from.id), chatId: idText_(c.chat && c.chat.id), payload: payload };
  }
  // невідомий тип — лише мінімальна технічна інформація, без бізнес-ефектів
  const keys = Object.keys(u).filter(function (k) { return k !== 'update_id'; });
  return { eventType: 'unknown:' + (keys[0] || 'empty'), userId: '', chatId: '',
    payload: { update_id: u.update_id, kind: 'unknown', keys: keys } };
}

/** Розбір команди: "/start@Bot arg" -> {name:'start', arg:'arg'}; інакше null. */
function parseCommand_(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(toText_(text).trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
}
