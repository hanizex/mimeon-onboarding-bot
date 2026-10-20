/**
 * Support.gs — звернення, КРИТИЧНІ звернення, відповіді команди з таблиці, статуси й орієнтир 72 год.
 *
 * Принципи:
 *  - Усі ID детерміновані від event_id (повтор події дає ті самі ID й не створює дублів).
 *  - КРИТИЧНЕ ставить лише явний вибір учасника (кнопка/команда). Слова в тексті ("терміново") нічого не змінюють.
 *  - Порядок кроку: повідомлення учаснику (Outbox) -> побічні дії (рядки таблиць) -> один запис стану учасника.
 *  - Відповідь команди: спершу завдання в Outbox, потім snapshot_created_at у "Відповіді".
 *    Після snapshot редагування тексту в таблиці вже не впливає на надіслане.
 *  - 72 год — орієнтир (sla_overdue — лише позначка), нічого не сповіщає й не робить звернення критичним.
 */

const TICKET_OPEN = ['new', 'in_progress', 'waiting_user'];
const REPLY_MAX_CHARS = 20000;
const REPLY_MAX_ATTACHMENTS = 10;
const SUPPORT_DIALOGS = ['support_body', 'support_details', 'support_choose'];
const KNOWN_COMMANDS = ['start', 'help', 'guide', 'support', 'critical', 'feedback', 'reward', 'stop', 'delete', 'cancel', 'mydata'];

function tickets_() {
  const t = table_('TICKETS');
  if (!t.loaded) t.load(3);
  return t;
}
function messages_() {
  const t = table_('MESSAGES');
  if (!t.loaded) t.load(3);
  return t;
}
function msgIdFor_(eventId) { return 'msg_' + sha256Hex_('msg|' + eventId).slice(0, 16); }

function sheetUrl_(schemaKey) {
  const ss = openSpreadsheet_();
  let url = ss.getUrl();
  try {
    const sh = ss.getSheetByName(SCHEMA[schemaKey].name);
    if (sh && typeof sh.getSheetId === 'function') url += '#gid=' + sh.getSheetId();
  } catch (e) { /* без gid */ }
  return url;
}

function dialogCtx_(p) { return safeJsonParse_(p.dialog_context_json, {}) || {}; }
function clearDialogPatch_() { return { dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }; }
function jsonStr_(o) { return JSON.stringify(o); }

// ---------- Вхідне повідомлення учасника ----------
function incomingInfo_(t) {
  const m = t.pl.message;
  const ms = Math.min(m.date ? m.date * 1000 : (parseIso_(t.ev.received_at) || t.now), t.now);
  const text = toText_((m.text !== null && m.text !== undefined) ? m.text : m.caption).trim();
  return {
    msgId: msgIdFor_(t.ev.event_id), createdMs: ms, createdIso: isoSec_(ms), text: text,
    atts: m.attachments || [], groupId: m.media_group_id || null, telegramId: m.message_id
  };
}
function previewOf_(info) {
  if (info.text) return previewText_(info.text, 120);
  if (info.atts.length) return '[вкладення: ' + info.atts[0].type + ']';
  return '[порожнє повідомлення]';
}

/** Створює (або знаходить) запис повідомлення й його вкладення. Ідемпотентно. */
function recordIncoming_(t, info, ticketId) {
  const existing = messages_().get(info.msgId);
  if (existing) return existing;
  const atts = recordAttachments_(t.p, t.ev, t.pl.message, info.msgId, ticketId);
  return messages_().append({
    message_record_id: info.msgId, participant_id: t.p.participant_id, ticket_id: ticketId || null, survey_id: null,
    direction: 'in', author_type: 'participant', source_update_id: toText_(t.ev.update_id), telegram_message_id: toText_(info.telegramId),
    reply_to_message_id: t.pl.message.reply_to_message_id || null, created_at: info.createdIso, body_text: info.text || null,
    attachment_ids: atts.map(function (a) { return a.attachment_id; }).join(',') || null, media_group_id: info.groupId, related_reply_id: null
  });
}

function linkMessageToTicket_(msg, ticketId) {
  markFeedback_(msg.participant_id, msg.created_at, 'support_ticket', ticketId);       // повідомлення в зверненні = фідбек (право на подяку)
  if (msg.ticket_id !== ticketId) messages_().update(msg, { ticket_id: ticketId });
  linkAttachmentsToTicket_(msg.attachment_ids, ticketId);
}

/** Детермінований ID звернення від повідомлення; при (практично неможливій) колізії довжина збільшується. */
function ticketIdFor_(msgRecordId, participantId, createdIso) {
  const h = sha256Hex_('ticket|' + msgRecordId);
  for (let n = 8; n <= 32; n += 4) {
    const id = 'T-' + h.slice(0, n).toUpperCase();
    const ex = tickets_().get(id);
    if (!ex || (ex.participant_id === participantId && ex.created_at === createdIso)) return id;
  }
  throw new SafeError('ticket_id_collision', 'Не вдалося підібрати унікальний ID звернення.');
}

function createTicketFromMessage_(t, msg, critical) {
  const S = t.S;
  const id = ticketIdFor_(msg.message_record_id, t.p.participant_id, msg.created_at);
  let tk = tickets_().get(id);
  if (!tk) {
    const createdMs = parseIso_(msg.created_at);
    const preview = msg.body_text ? previewText_(msg.body_text, 120) : (msg.attachment_ids ? '[вкладення]' : '[порожнє повідомлення]');
    tk = tickets_().append({
      ticket_id: id, participant_id: t.p.participant_id, created_at: msg.created_at, critical_by_user: critical === true,
      critical_marked_at: critical ? msg.created_at : null, status: 'new', subject_or_preview: preview, assigned_to: null,
      first_team_reply_at: null, last_activity_at: msg.created_at, waiting_since: msg.created_at,
      sla_due_at: isoSec_(createdMs + S.SUPPORT_FIRST_RESPONSE_HOURS * 3600000), sla_overdue: false, internal_notes: null,
      critical_alert_status: critical ? 'queued' : 'none', critical_alert_message_id: null
    });
  }
  linkMessageToTicket_(msg, id);
  if (tk.critical_by_user === true) ensureCriticalAlert_(tk, t.S);
  return tk;
}

/** Нове повідомлення учасника в існуючому зверненні: активність, повернення в роботу, відлік очікування. */
function touchTicketForParticipant_(tk, info, S) {
  const lastAct = parseIso_(tk.last_activity_at) || 0;
  if (info.createdMs <= lastAct) return tk;                 // подія вже застосована або старіша за актуальний стан
  const patch = { last_activity_at: info.createdIso };
  if (tk.status === 'waiting_user' || tk.status === 'resolved' || tk.status === 'closed') patch.status = 'in_progress';
  if (patch.status || !tk.waiting_since) {
    patch.waiting_since = info.createdIso;
    patch.sla_due_at = isoSec_(info.createdMs + S.SUPPORT_FIRST_RESPONSE_HOURS * 3600000);
    patch.sla_overdue = false;
  }
  return tickets_().update(tk, patch);
}

function ticketsOf_(participantId) {
  return tickets_().filter(function (x) { return x.participant_id === participantId; });
}
/** Останнє "поточне" звернення: активність не старіша за SUPPORT_THREAD_DAYS. */
function latestRecentTicket_(participantId, S, nowMs) {
  const limit = S.SUPPORT_THREAD_DAYS * 86400000;
  let best = null;
  ticketsOf_(participantId).forEach(function (x) {
    const act = parseIso_(x.last_activity_at) || parseIso_(x.created_at) || 0;
    if (nowMs - act > limit) return;
    if (!best || act > (parseIso_(best.last_activity_at) || parseIso_(best.created_at) || 0)) best = x;
  });
  return best;
}

/** Інший елемент того ж альбому з меншим message_id — тоді це продовження альбому, відповідати не треба. */
function albumSibling_(p, info) {
  if (!info.groupId) return null;
  const mine = Number(info.telegramId);
  return messages_().find(function (m) {
    return m.participant_id === p.participant_id && m.direction === 'in' && m.media_group_id === info.groupId &&
      m.message_record_id !== info.msgId && Number(m.telegram_message_id) < mine;
  });
}

// ---------- КРИТИЧНЕ сповіщення власнику ----------
/** Заголовок сповіщення. Додається в коді (не з шаблону), щоб правки текстів його не прибрали. Тестовий запис — окремий вигляд. */
function ownerAlertBanner_(tk) {
  const p = tk.participant_id ? participants_().get(tk.participant_id) : null;
  if (p && p.is_test_record === true) return '🧪 ТЕСТ — це звернення з тестового запису, не реальна людина\n\n';
  return '🔥🔥🔥 🚨 КРИТИЧНЕ — РЕАЛЬНИЙ УЧАСНИК 🚨 🔥🔥🔥\n\n';
}
function ensureCriticalAlert_(tk, S) {
  const owner = propGet_(PROP.OWNER_CHAT_ID);
  if (!owner) {
    reportIncident_('support', 'no_owner_for_alert', 'Критичне звернення створено, але OWNER_CHAT_ID не задано.', { level: 'critical', entityType: 'ticket', entityId: tk.ticket_id });
    tickets_().update(tk, { critical_alert_status: 'failed' });
    return;
  }
  const text = renderTemplate_('owner_alert', {
    ticket_id: tk.ticket_id,
    created_at_local: localDateTimeStr_(parseIso_(tk.critical_marked_at || tk.created_at), S.TIMEZONE),
    safe_preview: tk.subject_or_preview || '—',
    sheet_url: sheetUrl_('TICKETS')
  });
  enqueueOutbox_({
    idempotencyKey: 'critical_alert:' + tk.ticket_id, participantId: tk.participant_id, ticketId: tk.ticket_id,
    recipientChatId: owner, kind: 'owner_alert', payload: { text: ownerAlertBanner_(tk) + text }, priority: PRIORITY.OWNER_ALERT
  });
  if (!tk.critical_alert_status || tk.critical_alert_status === 'none') tickets_().update(tk, { critical_alert_status: 'queued' });
}

function markTicketCritical_(tk, atIso, S) {
  if (tk.critical_by_user !== true) {
    tk = tickets_().update(tk, { critical_by_user: true, critical_marked_at: atIso, critical_alert_status: 'queued' });
  }
  ensureCriticalAlert_(tk, S);       // ідемпотентно: повтор події не створює другого сповіщення
  return tk;
}

/** Післядія доставленого сповіщення власнику. */
function onOwnerAlertSent_(job) {
  if (!job.ticket_id) return;
  const tk = tickets_().get(job.ticket_id);
  if (!tk) return;
  if (tk.critical_alert_status !== 'sent' || (job.telegram_message_id && tk.critical_alert_message_id !== job.telegram_message_id)) {
    tickets_().update(tk, { critical_alert_status: 'sent', critical_alert_message_id: job.telegram_message_id || tk.critical_alert_message_id });
  }
  const p = participants_().get(tk.participant_id);
  if (p && p.contact_status !== 'blocked') {
    enqueueOutbox_({
      idempotencyKey: 'critical_notice:' + tk.ticket_id, participantId: p.participant_id, ticketId: tk.ticket_id, recipientChatId: p.chat_id,
      kind: 'support_notice', payload: { text: renderTemplate_('critical_alert_delivered', { ticket_id: tk.ticket_id }) }, priority: PRIORITY.SUPPORT
    });
  }
}

/** Невдалі/невизначені сповіщення відображаються в самому зверненні. */
function syncCriticalAlertStatuses_() {
  const alertJobs = outbox_().rows.filter(function (j) { return j.message_kind === 'owner_alert' && j.ticket_id; });
  if (!alertJobs.length) return;                      // нічого читати, якщо сповіщень у роботі немає
  const tbl = tickets_();
  alertJobs.forEach(function (j) {
    const tk = tbl.get(j.ticket_id);
    if (!tk || tk.critical_alert_status === 'sent') return;
    let want = null;
    if (j.status === 'failed' || j.status === 'cancelled') want = 'failed';
    else if (j.status === 'delivery_unknown') want = 'delivery_unknown';
    else if (j.status === 'queued' || j.status === 'sending' || j.status === 'retry_wait') want = 'queued';
    if (want && tk.critical_alert_status !== want) tbl.update(tk, { critical_alert_status: want });
  });
}

// ---------- Вхід: меню, команди, діалоги ----------
function supportPromptKb_() { return kbForceReply_('Опиши, що сталося'); }
function detailsKb_() { return kbReply_([[BTN.DONE]]); }

function onMenuSupport_(t) {
  t.set({ dialog_type: 'support_body', dialog_ref_id: null, dialog_context_json: jsonStr_({ critical: false }) });
  t.say('support_prompt', renderTemplate_('support_prompt'), supportPromptKb_());
  return true;
}

function onMenuCritical_(t) {
  const open = latestRecentTicket_(t.p.participant_id, t.S, t.now);
  if (open && TICKET_OPEN.indexOf(open.status) >= 0 && open.critical_by_user !== true) {
    t.set({ dialog_type: 'support_choose', dialog_ref_id: open.ticket_id, dialog_context_json: jsonStr_({ mode: 'critical', ticket_id: open.ticket_id }) });
    t.say('critical_choose', renderTemplate_('critical_choose', { ticket_id: open.ticket_id }), kbReply_([[BTN.CHOOSE_UPGRADE], [BTN.CHOOSE_NEW_CRITICAL], [BTN.CANCEL]], { oneTime: true }));
    return true;
  }
  t.set({ dialog_type: 'support_body', dialog_ref_id: null, dialog_context_json: jsonStr_({ critical: true }) });
  t.say('critical_prompt', renderTemplate_('critical_prompt'), supportPromptKb_());
  return true;
}

/** /cancel у діалозі звернення. */
function onCancelSupport_(t) {
  const p = t.p;
  if (SUPPORT_DIALOGS.indexOf(p.dialog_type) < 0) return false;
  t.set(clearDialogPatch_());
  if (p.dialog_type === 'support_details') {
    t.say('details_done', renderTemplate_('support_details_done', { ticket_id: p.dialog_ref_id || '—' }));
    surveyResumeHint_(t);
  } else {
    t.say('cancelled', renderTemplate_(p.dialog_type === 'support_choose' && dialogCtx_(p).mode === 'free' ? 'support_choose_cancelled' : 'support_cancelled'));
  }
  return true;
}

function onDialogMessageSupport_(t) {
  switch (t.p.dialog_type) {
    case 'support_body': return supportBody_(t);
    case 'support_details': return supportDetails_(t);
    case 'support_choose': return supportChoose_(t);
    default: return false;
  }
}

function tooLargeNotice_(t, info) {
  const mb = oversizedAttachmentMb_(info.atts, t.S);
  if (mb) t.say('too_large', renderTemplate_('attachment_too_large', { mb: String(mb) }), null);
}

/** Спільне завершення: нове звернення з цього повідомлення + підтвердження + запит деталей. */
function startTicketFromIncoming_(t, info, critical) {
  const p = t.p, S = t.S;
  const tid = ticketIdFor_(info.msgId, p.participant_id, info.createdIso);
  t.set({ dialog_type: 'support_details', dialog_ref_id: tid, dialog_context_json: jsonStr_({ ticket_id: tid }) });
  const vals = { ticket_id: tid, hours: String(S.SUPPORT_FIRST_RESPONSE_HOURS) };
  t.say('saved', renderTemplate_(critical ? 'critical_saved' : 'support_saved', vals), null);
  t.say('details', renderTemplate_('support_details_prompt'), detailsKb_());
  tooLargeNotice_(t, info);
  t.run(function () {
    const msg = recordIncoming_(t, info, null);
    createTicketFromMessage_(t, msg, critical);
  });
}

function supportBody_(t) {
  const info = incomingInfo_(t);
  const text = normText_(t.pl.message.text);
  if (btnIs_(text, BTN.CANCEL)) { t.set(clearDialogPatch_()); t.say('cancelled', renderTemplate_('support_cancelled')); return true; }
  if (!info.text && !info.atts.length) {
    t.say('support_prompt', renderTemplate_('support_prompt'), supportPromptKb_());
    return true;
  }
  startTicketFromIncoming_(t, info, dialogCtx_(t.p).critical === true);
  return true;
}

function appendToTicket_(t, info, tk) {
  const msg = recordIncoming_(t, info, tk.ticket_id);
  linkMessageToTicket_(msg, tk.ticket_id);
  touchTicketForParticipant_(tickets_().get(tk.ticket_id) || tk, info, t.S);
  return msg;
}

function supportDetails_(t) {
  const p = t.p;
  const info = incomingInfo_(t);
  const text = normText_(t.pl.message.text);
  const ticketId = dialogCtx_(p).ticket_id || p.dialog_ref_id;
  const tk = ticketId ? tickets_().get(ticketId) : null;
  if (!tk) { t.set(clearDialogPatch_()); return onFreeMessage_(t); }          // звернення зникло з таблиці — обробляємо як нове
  if (btnIs_(text, BTN.DONE) || btnIs_(text, BTN.CANCEL)) {
    t.set(clearDialogPatch_());
    t.say('details_done', renderTemplate_('support_details_done', { ticket_id: tk.ticket_id }));
    surveyResumeHint_(t);
    return true;
  }
  if (!info.text && !info.atts.length) { t.say('details', renderTemplate_('support_details_prompt'), detailsKb_()); return true; }
  const silent = !!albumSibling_(p, info);
  if (!silent) t.say('added', renderTemplate_('support_added', { ticket_id: tk.ticket_id }), detailsKb_());
  tooLargeNotice_(t, info);
  t.run(function () { appendToTicket_(t, info, tk); });
  return true;
}

function supportChoose_(t) {
  const p = t.p, S = t.S;
  const ctx = dialogCtx_(p);
  const info = incomingInfo_(t);
  const text = normText_(t.pl.message.text);
  const tk = ctx.ticket_id ? tickets_().get(ctx.ticket_id) : null;
  if (!tk && ctx.mode !== 'free') { t.set(clearDialogPatch_()); return onFreeMessage_(t); }
  if (btnIs_(text, BTN.CANCEL)) {
    t.set(clearDialogPatch_());
    t.say('cancelled', renderTemplate_(ctx.mode === 'free' ? 'support_choose_cancelled' : 'support_cancelled'));
    return true;
  }
  if (ctx.mode === 'critical') {
    if (btnIs_(text, BTN.CHOOSE_UPGRADE)) {
      t.set({ dialog_type: 'support_details', dialog_ref_id: tk.ticket_id, dialog_context_json: jsonStr_({ ticket_id: tk.ticket_id }) });
      t.say('upgraded', renderTemplate_('critical_upgraded', { ticket_id: tk.ticket_id }), null);
      t.say('details', renderTemplate_('support_details_prompt'), detailsKb_());
      t.run(function () { markTicketCritical_(tickets_().get(tk.ticket_id) || tk, isoSec_(t.now), S); });
      return true;
    }
    if (btnIs_(text, BTN.CHOOSE_NEW_CRITICAL)) {
      t.set({ dialog_type: 'support_body', dialog_ref_id: null, dialog_context_json: jsonStr_({ critical: true }) });
      t.say('critical_prompt', renderTemplate_('critical_prompt'), supportPromptKb_());
      return true;
    }
    t.say('critical_choose', renderTemplate_('critical_choose', { ticket_id: tk.ticket_id }), kbReply_([[BTN.CHOOSE_UPGRADE], [BTN.CHOOSE_NEW_CRITICAL], [BTN.CANCEL]], { oneTime: true }));
    return true;
  }
  // mode === 'free': у черзі лежать повідомлення без звернення
  const pending = Array.isArray(ctx.pending) ? ctx.pending : [];
  if (btnIs_(text, BTN.CHOOSE_FEEDBACK) && pending.length) {
    t.set(clearDialogPatch_());
    t.say('fb_free_saved', renderTemplate_('free_feedback_saved'), mainMenuKb_());
    t.run(function () { saveAsFeedback_(t, pending); });
    return true;
  }
  if (btnIs_(text, BTN.CHOOSE_NEW_CRITICAL) && pending.length) {
    const first = messages_().get(pending[0]);
    if (!first) { t.set(clearDialogPatch_()); t.say('cancelled', renderTemplate_('support_cancelled')); return true; }
    const ctid = ticketIdFor_(first.message_record_id, p.participant_id, first.created_at);
    t.set({ dialog_type: 'support_details', dialog_ref_id: ctid, dialog_context_json: jsonStr_({ ticket_id: ctid }) });
    t.say('saved', renderTemplate_('critical_saved', { ticket_id: ctid, hours: String(S.SUPPORT_FIRST_RESPONSE_HOURS) }), null);
    t.say('details', renderTemplate_('support_details_prompt'), detailsKb_());
    t.run(function () {
      const nt = createTicketFromMessage_(t, messages_().get(pending[0]), true);
      pending.slice(1).forEach(function (id) {
        const m = messages_().get(id);
        if (m) linkMessageToTicket_(m, nt.ticket_id);
      });
    });
    return true;
  }
  if (tk && btnIs_(text, BTN.CHOOSE_ADD)) {
    t.set(clearDialogPatch_());
    t.say('choose_done', renderTemplate_('support_choose_done', { ticket_id: tk.ticket_id }));
    t.run(function () {
      pending.forEach(function (id) {
        const m = messages_().get(id);
        if (!m) return;
        linkMessageToTicket_(m, tk.ticket_id);
        touchTicketForParticipant_(tickets_().get(tk.ticket_id) || tk, { createdMs: parseIso_(m.created_at), createdIso: m.created_at }, S);
      });
    });
    return true;
  }
  if (btnIs_(text, BTN.CHOOSE_NEW) && pending.length) {
    const firstMsg = messages_().get(pending[0]);
    if (!firstMsg) { t.set(clearDialogPatch_()); t.say('cancelled', renderTemplate_('support_cancelled')); return true; }
    const tid = ticketIdFor_(firstMsg.message_record_id, p.participant_id, firstMsg.created_at);
    t.set({ dialog_type: 'support_details', dialog_ref_id: tid, dialog_context_json: jsonStr_({ ticket_id: tid }) });
    t.say('saved', renderTemplate_('support_saved', { ticket_id: tid, hours: String(S.SUPPORT_FIRST_RESPONSE_HOURS) }), null);
    t.say('details', renderTemplate_('support_details_prompt'), detailsKb_());
    t.run(function () {
      const nt = createTicketFromMessage_(t, messages_().get(pending[0]), false);
      pending.slice(1).forEach(function (id) {
        const m = messages_().get(id);
        if (m) linkMessageToTicket_(m, nt.ticket_id);
      });
    });
    return true;
  }
  // будь-що інше — ще одне повідомлення, що чекає вибору (елемент альбому — без повторного запитання)
  if (!info.text && !info.atts.length) {
    t.say('support_choose', freeChooseText_(tk), chooseKb_(!!tk));
    return true;
  }
  const silent = !!albumSibling_(p, info);
  const nextPending = pending.indexOf(info.msgId) >= 0 ? pending : pending.concat([info.msgId]);
  t.set({ dialog_context_json: jsonStr_({ mode: 'free', ticket_id: tk ? tk.ticket_id : null, pending: nextPending }) });
  if (!silent) t.say('support_choose', freeChooseText_(tk), chooseKb_(!!tk));
  tooLargeNotice_(t, info);
  t.run(function () { recordIncoming_(t, info, null); });
  return true;
}
/** Клавіатура вибору для вільного повідомлення: проблема / фідбек / КРИТИЧНЕ; «додати до останнього» лише коли є нещодавнє звернення. */
function chooseKb_(hasTicket) {
  const rows = [];
  if (hasTicket) rows.push([BTN.CHOOSE_ADD]);
  rows.push([BTN.CHOOSE_NEW, BTN.CHOOSE_FEEDBACK]);
  rows.push([BTN.CHOOSE_NEW_CRITICAL, BTN.CANCEL]);
  return kbReply_(rows, { oneTime: true });
}
function freeChooseText_(tk) {
  return tk ? renderTemplate_('free_choose_ticket', { ticket_id: tk.ticket_id }) : renderTemplate_('free_choose');
}
/** Вільні повідомлення -> фідбек (не звернення): позначка в тексті, прив'язка до анкети, право на подяку. */
function saveAsFeedback_(t, pending) {
  const sv = surveyOf_(t.p.participant_id);
  pending.forEach(function (id) {
    const m = messages_().get(id);
    if (!m) return;
    const patch = {};
    if (!/^\[Новий фідбек\]/.test(m.body_text || '')) patch.body_text = ('[Новий фідбек] ' + (m.body_text || '')).trim();
    if (sv && m.survey_id !== sv.survey_id) patch.survey_id = sv.survey_id;
    if (m.ticket_id) patch.ticket_id = null;
    if (Object.keys(patch).length) messages_().update(m, patch);
    markFeedback_(t.p.participant_id, m.created_at, 'feedback_note', m.message_record_id);
  });
}

/** Вільне повідомлення поза діалогом і анкетою — не ігноруємо. */
function onFreeMessage_(t) {
  const p = t.p, S = t.S;
  const info = incomingInfo_(t);
  if (!info.text && !info.atts.length) { t.say('unknown', renderTemplate_('unknown_text')); return true; }

  const sib = albumSibling_(p, info);
  if (sib && sib.ticket_id) {                       // продовження альбому, який уже став зверненням
    const stk = tickets_().get(sib.ticket_id);
    if (stk) {
      tooLargeNotice_(t, info);
      t.run(function () { appendToTicket_(t, info, stk); });
      return true;
    }
  }
  const tk = latestRecentTicket_(p.participant_id, S, info.createdMs);
  if (tk && tk.status === 'waiting_user') {         // команда чекає на учасника — це відповідь
    t.say('reply_added', renderTemplate_('support_reply_added', { ticket_id: tk.ticket_id }));
    tooLargeNotice_(t, info);
    t.run(function () { appendToTicket_(t, info, tk); });
    return true;
  }
  // питаємо, що це: проблема, фідбек чи КРИТИЧНЕ (і, якщо є нещодавнє звернення, чи додати до нього). Повідомлення вже збережено.
  t.set({ dialog_type: 'support_choose', dialog_ref_id: tk ? tk.ticket_id : null, dialog_context_json: jsonStr_({ mode: 'free', ticket_id: tk ? tk.ticket_id : null, pending: [info.msgId] }) });
  t.say('support_choose', freeChooseText_(tk), chooseKb_(!!tk));
  tooLargeNotice_(t, info);
  t.run(function () { recordIncoming_(t, info, null); });
  return true;
}

/** Редагування повідомлення, яке вже в зверненні: зберігаємо як новий рядок, нічого не відповідаємо. */
function onEditedMessageSupport_(args) {
  const ev = args.ev, m = args.pl.message, p = args.p;
  const orig = messages_().find(function (x) {
    return x.participant_id === p.participant_id && x.direction === 'in' && x.telegram_message_id === toText_(m.message_id);
  });
  if (!orig) return false;
  const rid = msgIdFor_(ev.event_id);
  if (messages_().get(rid)) return true;
  const ms = Math.min(((m.edit_date || m.date) ? (m.edit_date || m.date) * 1000 : (parseIso_(ev.received_at) || nowMs_())), nowMs_());
  const body = toText_((m.text !== null && m.text !== undefined) ? m.text : m.caption);
  messages_().append({
    message_record_id: rid, participant_id: p.participant_id, ticket_id: orig.ticket_id, survey_id: orig.survey_id, direction: 'in',
    author_type: 'participant', source_update_id: toText_(ev.update_id), telegram_message_id: toText_(m.message_id), reply_to_message_id: orig.reply_to_message_id,
    created_at: isoSec_(ms), body_text: '[Редагування] ' + body, attachment_ids: null, media_group_id: orig.media_group_id, related_reply_id: null
  });
  const tk = orig.ticket_id ? tickets_().get(orig.ticket_id) : null;
  if (tk && (parseIso_(tk.last_activity_at) || 0) < ms) tickets_().update(tk, { last_activity_at: isoSec_(ms) });
  return true;
}

// ---------- Відповіді команди з таблиці ----------
function readReplyRows_() {
  const t = table_('REPLIES');
  const sh = t.sheet();
  t.keys();
  const maxRows = sh.getMaxRows();
  const out = { t: t, rows: [] };
  if (maxRows < 3) return out;
  const vals = sh.getRange(3, 1, maxRows - 2, t._keys.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    const row = t._toObj(vals[i], 3 + i);
    if (!row.ticket_id && !row.response_text && !row.reply_id && !row.attachment_ids) continue;
    out.rows.push(row);
  }
  return out;
}
/** Записує окремі клітинки рядка "Відповіді" (рядок могла додати людина — повного перезапису не робимо). */
function replyWrite_(t, row, patch) {
  const sh = t.sheet();
  Object.keys(patch).forEach(function (k) {
    const v = patch[k] === undefined ? null : patch[k];
    if (sameValue_(row[k], v)) return;
    sh.getRange(row._row, t.colIdx(k)).setValue(toCell_(t.col(k), v));
    row[k] = v;
  });
}
function parseIdList_(s) { return toText_(s).split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(Boolean); }

function validateReply_(row) {
  const ticketId = toText_(row.ticket_id).trim();
  if (!ticketId) return { code: 'no_ticket', note: 'Не вказано ticket_id. Скопіюйте ID зі сторінки "Звернення".' };
  const tk = tickets_().get(ticketId);
  if (!tk) return { code: 'ticket_not_found', note: 'Звернення ' + ticketId + ' не знайдено. Перевірте ID на сторінці "Звернення".' };
  const p = participants_().get(tk.participant_id);
  if (!p) return { code: 'participant_gone', note: 'Учасника цього звернення не знайдено (дані могли бути видалені).' };
  const text = toText_(row.response_text).trim();
  const attIds = parseIdList_(row.attachment_ids);
  if (!text && !attIds.length) return { code: 'empty_reply', note: 'Порожня відповідь: заповніть "Текст для учасника" або "ID вкладень".' };
  if (text.length > REPLY_MAX_CHARS) return { code: 'too_long', note: 'Текст довший за ' + REPLY_MAX_CHARS + ' символів. Скоротіть або розділіть на кілька відповідей.' };
  if (attIds.length > REPLY_MAX_ATTACHMENTS) return { code: 'too_many_attachments', note: 'Забагато вкладень (максимум ' + REPLY_MAX_ATTACHMENTS + ').' };
  const atts = [];
  for (let i = 0; i < attIds.length; i++) {
    const a = attachments_().get(attIds[i]);
    if (!a) return { code: 'attachment_not_found', note: 'Вкладення ' + attIds[i] + ' не знайдено.' };
    if (a.participant_id !== tk.participant_id) return { code: 'attachment_foreign', note: 'Вкладення ' + attIds[i] + ' належить іншому учаснику. Можна додавати лише вкладення цього ж учасника.' };
    if (!TG_MEDIA_METHODS[a.media_type]) return { code: 'attachment_unsupported', note: 'Тип вкладення ' + attIds[i] + ' не підтримується для відправки.' };
    atts.push(a);
  }
  if (p.contact_status === 'blocked') return { code: 'participant_blocked', note: 'Учасник заблокував бота — відповідь доставити неможливо. Дані збережено.' };
  return { ok: true, ticket: tk, participant: p, text: text, atts: atts };
}

function newReplyId_() { return 'R-' + randomCode_(8); }

function processTeamReplies_(S) {
  const rr = readReplyRows_();
  const t = rr.t;
  if (!rr.rows.length) return;
  const nowIso = nowIso_();
  const seen = {};
  rr.rows.forEach(function (row) {
    // 1) ID відповіді призначається системою; копія рядка (дубль ID) стає новою чернеткою
    if (row.reply_id && seen[row.reply_id]) {
      replyWrite_(t, row, {
        reply_id: newReplyId_(), snapshot_created_at: null, delivery_status: 'draft', sent_at: null, telegram_message_id: null,
        send_requested: false, prepared_at: nowIso, error_code: 'duplicate_reply_id',
        error_note: 'Цей рядок — копія іншого. Призначено новий reply_id; перевірте текст і поставте галочку "Надіслати" знову.'
      });
    }
    if (!row.reply_id) replyWrite_(t, row, { reply_id: newReplyId_(), prepared_at: row.prepared_at || nowIso, delivery_status: row.delivery_status || 'draft' });
    seen[row.reply_id] = true;
    if (!row.delivery_status) replyWrite_(t, row, { delivery_status: 'draft' });

    // 2) надсилаємо лише з галочкою й лише раз
    if (row.send_requested !== true || row.snapshot_created_at) return;
    const v = validateReply_(row);
    if (!v.ok) {
      replyWrite_(t, row, { delivery_status: 'draft', error_code: v.code, error_note: v.note + ' Виправте й поставте галочку знову.', send_requested: false });
      return;
    }
    // 3) спершу завдання в Outbox (ідемпотентні ключі), потім snapshot у таблиці
    const key = 'reply:' + row.reply_id;
    const base = { participantId: v.participant.participant_id, ticketId: v.ticket.ticket_id, replyId: row.reply_id, recipientChatId: v.participant.chat_id, kind: 'support_reply', priority: PRIORITY.SUPPORT };
    if (v.text) enqueueOutbox_(Object.assign({}, base, { idempotencyKey: key, payload: { text: v.text } }));
    v.atts.forEach(function (a) {
      enqueueOutbox_(Object.assign({}, base, { idempotencyKey: key + ':att:' + a.attachment_id, payload: { media: { type: a.media_type, file_id: a.file_id } } }));
    });
    replyWrite_(t, row, { snapshot_created_at: nowIso, delivery_status: 'queued', error_code: null, error_note: null, prepared_by: row.prepared_by });
  });
}

function aggregateReplyJobs_(jobs) {
  const live = jobs.filter(function (j) { return j.status !== 'cancelled'; });
  if (!live.length) {
    const last = jobs[jobs.length - 1];
    return { status: 'cancelled', code: 'cancelled', note: trunc_((last && last.last_error_note) || 'Завдання скасовано.', 300) };
  }
  if (live.some(function (j) { return j.status === 'queued' || j.status === 'sending' || j.status === 'retry_wait'; })) return { status: 'queued' };
  const anySent = live.some(function (j) { return j.status === 'sent'; });
  const unk = live.filter(function (j) { return j.status === 'delivery_unknown'; })[0];
  if (unk) return { status: 'delivery_unknown', code: 'delivery_unknown', note: 'Невідомо, чи доставлено (завдання ' + unk.job_id + ' у "Вихідні"). Перевірте чат учасника й виставте operator_action.' + (anySent ? ' Частину вже надіслано.' : '') };
  const bad = live.filter(function (j) { return j.status === 'failed'; })[0];
  if (bad) return { status: 'failed', code: bad.last_error_code || 'failed', note: trunc_((anySent ? 'Частково надіслано. ' : '') + (bad.last_error_note || 'Не вдалося надіслати.'), 300) };
  const sorted = live.slice().sort(function (a, b) { return a._row - b._row; });
  let maxSent = 0;
  sorted.forEach(function (j) { maxSent = Math.max(maxSent, parseIso_(j.sent_at) || 0); });
  return { status: 'sent', sent_at: maxSent ? isoSec_(maxSent) : null, tg: sorted[0].telegram_message_id };
}

/** Переносить фактичний стан доставки з "Вихідні" у "Відповіді". Викликається до просування водяного знака Outbox. */
function syncReplyStatuses_() {
  const byReply = {};
  outbox_().rows.forEach(function (j) { if (j.reply_id) (byReply[j.reply_id] = byReply[j.reply_id] || []).push(j); });
  const ids = Object.keys(byReply);
  if (!ids.length) return;
  const rr = readReplyRows_();
  rr.rows.forEach(function (row) {
    if (!row.reply_id || !byReply[row.reply_id] || !row.snapshot_created_at) return;
    const agg = aggregateReplyJobs_(byReply[row.reply_id]);
    const patch = { delivery_status: agg.status };
    if (agg.status === 'sent') { patch.sent_at = agg.sent_at; patch.telegram_message_id = agg.tg || null; patch.error_code = null; patch.error_note = null; }
    else if (agg.status === 'queued') { patch.error_code = null; patch.error_note = null; }
    else { patch.error_code = agg.code || null; patch.error_note = agg.note || null; }
    replyWrite_(rr.t, row, patch);
  });
}

/** Після доставки частини відповіді: журнал повідомлення + стан звернення (ідемпотентно). */
function onSupportReplySent_(job) {
  const payload = safeJsonParse_(job.payload_json, {});
  const rid = 'msg_' + sha256Hex_('out|' + job.idempotency_key).slice(0, 16);
  if (!messages_().get(rid)) {
    let attId = null;
    if (payload.file_id) {
      const a = attachments_().find(function (x) { return x.participant_id === job.participant_id && x.file_id === payload.file_id; });
      attId = a ? a.attachment_id : null;
    }
    messages_().append({
      message_record_id: rid, participant_id: job.participant_id, ticket_id: job.ticket_id || null, survey_id: null, direction: 'out', author_type: 'team',
      source_update_id: null, telegram_message_id: job.telegram_message_id || null, reply_to_message_id: null,
      created_at: job.sent_at || nowIso_(), body_text: payload.text || payload.caption || null, attachment_ids: attId, media_group_id: null, related_reply_id: job.reply_id || null
    });
  }
  const tk = job.ticket_id ? tickets_().get(job.ticket_id) : null;
  if (!tk) return;
  const sentMs = parseIso_(job.sent_at) || nowMs_();
  const patch = {};
  if (!tk.first_team_reply_at) patch.first_team_reply_at = job.sent_at || isoSec_(sentMs);
  if (sentMs > (parseIso_(tk.last_activity_at) || 0)) patch.last_activity_at = job.sent_at || isoSec_(sentMs);
  // учасник написав у це звернення вже після фіксації відповіді (snapshot) — тоді він знову чекає на команду
  const snap = parseIso_(job.created_at);
  const participantWroteAfter = snap !== null && !!messages_().find(function (m) {
    return m.ticket_id === tk.ticket_id && m.direction === 'in' && (parseIso_(m.created_at) || 0) > snap;
  });
  if (tk.status === 'new' || tk.status === 'in_progress') {
    if (participantWroteAfter) { if (tk.status === 'new') patch.status = 'in_progress'; }
    else { patch.status = 'waiting_user'; patch.waiting_since = null; patch.sla_overdue = false; }
  }
  if (Object.keys(patch).length) tickets_().update(tk, patch);
}

// ---------- Обслуговування (орієнтир 72 год) ----------
function supportHousekeeping_(S) {
  const last = parseIso_(propGet_(PROP.SUPPORT_HK_AT));
  const now = nowMs_();
  if (last !== null && now - last < 10 * 60000) return;
  tickets_().rows.forEach(function (tk) {
    const open = TICKET_OPEN.indexOf(tk.status) >= 0;
    const due = parseIso_(tk.sla_due_at);
    const overdue = open && tk.waiting_since !== null && due !== null && due < now;
    if ((tk.sla_overdue === true) !== overdue) tickets_().update(tk, { sla_overdue: overdue });
  });
  propSet_(PROP.SUPPORT_HK_AT, isoSec_(now));
}

/** Один виклик після доставки Outbox: статуси відповідей, сповіщень, обслуговування. Збій кроку не ламає решту. */
function syncSupportStatuses_(S) {
  [['replies', syncReplyStatuses_], ['alerts', syncCriticalAlertStatuses_],
   ['sla', function () { supportHousekeeping_(S); }], ['viewer', function () { viewerHousekeeping_(S); }]].forEach(function (step) {
    try { step[1](); } catch (e) {
      reportIncident_('support', 'sync_' + step[0] + '_failed', 'Крок "' + step[0] + '" не виконано: ' + scrub_(e && e.message), { level: 'error' });
    }
  });
}

/** Лічильники для /status власника. */
function supportStatusLines_() {
  const all = tickets_().rows;
  const open = all.filter(function (x) { return TICKET_OPEN.indexOf(x.status) >= 0; });
  return 'Звернень відкритих: ' + open.length + ' (КРИТИЧНИХ: ' + open.filter(function (x) { return x.critical_by_user === true; }).length +
    ', понад орієнтир: ' + open.filter(function (x) { return x.sla_overdue === true; }).length + ')';
}
