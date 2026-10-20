/**
 * Ack.gs — миттєве підтвердження «⏳ Обробляю…».
 *
 * Навіщо: відповідь займає 2–10 с, і в цей час учасник не знає, що бот отримав повідомлення, і клацає зайве.
 * Як: одразу після стійкого збереження події (Inbox + offset) бот надсилає коротке повідомлення і ховає клавіатуру,
 * тож натискати нічого. Перед відправкою відповіді повідомлення оновлюється («майже готово»), після відповіді видаляється.
 * Нову клавіатуру приносить сама відповідь. Якщо відповіді з клавіатурою не було, бот повертає клавіатуру окремим повідомленням.
 *
 * Стан («очікують») — у Script Properties (ACK_PENDING): {chat_id: {m: message_id, at: мс, hid: bool, st: 1|2, e: event_id}}.
 * Усі помилки тут не критичні: підтвердження — допоміжне, відповідь учаснику від нього не залежить.
 */

const ACK_MAX_PER_BATCH = 6;
const ACK_STALE_MS = 150000;

function ackPending_() { return safeJsonParse_(propGet_(PROP.ACK_PENDING), null) || {}; }
function ackSave_(m) {
  if (Object.keys(m).length) propSet_(PROP.ACK_PENDING, JSON.stringify(m));
  else propDelete_(PROP.ACK_PENDING);
}

/** chat_id, якщо на це оновлення треба відповісти підтвердженням; інакше null. */
function ackChatFor_(S, u) {
  const m = u && u.message;
  if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return null;
  const hasContent = (typeof m.text === 'string' && m.text.length) || m.caption || m.photo || m.voice || m.video || m.document || m.audio || m.animation || m.video_note || m.sticker;
  if (!hasContent) return null;
  if (typeof m.text === 'string' && /^\/bind_owner(@\w+)?(\s|$)/i.test(m.text)) return null;
  const chat = String(m.chat.id);
  if (!chatAllowed_(chat, 'ack', S)) return null;
  const owner = propGet_(PROP.OWNER_CHAT_ID);
  if (owner && chat === String(owner) && S.TEST_CHAT_ALLOWLIST.indexOf(chat) < 0) return null;   // службовий чат власника — не учасник
  return chat;
}

/** Викликається одразу після збереження порції оновлень. */
function ackSend_(S, updates, botId) {
  try {
    if (!S.ACK_ENABLED) return;
    if (propGet_(PROP.SETUP_MODE) === 'true') return;
    const chats = {};
    updates.forEach(function (u) {
      const chat = ackChatFor_(S, u);
      if (chat) chats[chat] = botId + ':' + u.update_id;
    });
    const list = Object.keys(chats).slice(0, ACK_MAX_PER_BATCH);
    if (!list.length) return;
    const pend = ackPending_();
    let changed = false;
    list.forEach(function (chat) {
      if (pend[chat]) { pend[chat].e = chats[chat]; changed = true; return; }          // попереднє підтвердження ще висить: нове не створюємо
      const payload = { text: renderTemplate_('ack_processing') };
      if (S.ACK_HIDE_KEYBOARD) payload.reply_markup = kbRemove_();
      const r = tgSendMessage_(chat, payload);
      if (r.ok && r.result && r.result.message_id) {
        pend[chat] = { m: r.result.message_id, at: nowMs_(), hid: !!S.ACK_HIDE_KEYBOARD, st: 1, e: chats[chat] };
        changed = true;
      }
    });
    if (changed) ackSave_(pend);
  } catch (e) { /* підтвердження не повинне ламати обробку */ }
}

/** Після обробки, перед відправкою відповіді: «майже готово» (друга ступінь прогрес-бару). */
function ackProgress_(S) {
  try {
    if (!S.ACK_ENABLED) return;
    const pend = ackPending_();
    let changed = false;
    Object.keys(pend).slice(0, ACK_MAX_PER_BATCH).forEach(function (chat) {
      const a = pend[chat];
      if (a.st !== 1) return;
      tgCall_('editMessageText', { chat_id: chat, message_id: a.m, text: renderTemplate_('ack_almost') });
      a.st = 2; changed = true;
    });
    if (changed) ackSave_(pend);
  } catch (e) { /* не критично */ }
}

function ackFallbackKb_(chat) {
  const p = participants_().find(function (x) { return String(x.chat_id) === String(chat); });
  if (!p || !p.consent_at) return null;
  if (p.dialog_type === 'survey_question') {
    const ctx = dialogCtx_(p);
    if (ctx.q && SURVEY_Q[ctx.q]) return surveyKb_(ctx.q, ctx);
  }
  return mainMenuKb_();
}

/** Після доставки: прибирає підтвердження, а за потреби повертає клавіатуру. */
function cleanupAcks_(S) {
  try {
    const pend = ackPending_();
    const chats = Object.keys(pend);
    if (!chats.length) return;
    const now = nowMs_();
    let changed = false;
    chats.forEach(function (chat) {
      const a = pend[chat];
      const since = a.at - 1000;
      const jobs = outbox_().rows.filter(function (j) {
        return String(j.recipient_chat_id) === String(chat) && (parseIso_(j.created_at) || 0) >= since && j.message_kind !== 'owner_alert';
      });
      const open = jobs.some(function (j) { return j.status === 'queued' || j.status === 'sending' || j.status === 'retry_wait'; });
      const sent = jobs.filter(function (j) { return j.status === 'sent'; });
      const ev = a.e ? inbox_().get(a.e) : null;
      const evDone = !ev || (ev.status !== 'pending' && ev.status !== 'held');
      const stale = now - a.at > ACK_STALE_MS;
      const finished = stale || (!open && (sent.length > 0 || evDone));
      if (!finished) return;
      tgCall_('deleteMessage', { chat_id: chat, message_id: a.m });
      if (a.hid) {
        const hasKb = sent.some(function (j) { const pl = safeJsonParse_(j.payload_json, {}) || {}; return !!(pl.reply_markup && pl.reply_markup.keyboard); });
        if (!hasKb) {
          const kb = ackFallbackKb_(chat);
          if (kb) tgSendMessage_(chat, { text: renderTemplate_('ack_restore'), reply_markup: kb });
        }
      }
      delete pend[chat];
      changed = true;
    });
    if (changed) ackSave_(pend);
  } catch (e) { /* не критично */ }
}
