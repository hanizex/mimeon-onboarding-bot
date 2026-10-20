/**
 * Outbox.gs — вихідна черга: постановка (ідемпотентна), доставка, повтори, delivery_unknown,
 * дії оператора, післядії після доставки.
 *
 * Статуси: queued, sending, sent, retry_wait, failed, delivery_unknown, cancelled.
 * Telegram не гарантує exactly-once: якщо запит МІГ бути прийнятий, але відповідь загубилася,
 * автоматичного повтору немає — завдання стає delivery_unknown і чекає явної дії оператора.
 */

const OWNER_KINDS = ['owner_alert', 'owner_incident', 'owner_bind_confirm', 'owner_status', 'owner_notice'];
const BACKOFF_SECONDS = [60, 120, 300, 900, 3600, 7200, 14400];

function outbox_() {
  const t = table_('OUTBOX');
  if (!t.loaded) t.load(parseInt(propGet_(PROP.WM_OUTBOX) || '3', 10));
  return t;
}
function outboxKeys_() {
  const c = G();
  if (!c.outboxKeys) {
    c.outboxKeys = {};
    table_('OUTBOX').readColumn('idempotency_key').forEach(function (k) { if (k) c.outboxKeys[k] = true; });
  }
  return c.outboxKeys;
}

/**
 * Ставить завдання в чергу. Повторний виклик з тим самим ключем нічого не створює.
 * opts: idempotencyKey, participantId, ticketId, replyId, recipientChatId, kind, payload{text,reply_markup},
 *       priority, scheduleVersion, dueAtMs, meta{proactive,scheduled,deferrable}
 * Великий текст ділиться на частини з ключами key#p1.. (клавіатура лише на останній).
 */
function enqueueOutbox_(opts) {
  if (!opts.idempotencyKey) throw new SafeError('no_idempotency_key');
  if (!opts.recipientChatId) throw new SafeError('no_recipient', 'Немає chat_id одержувача.');
  const keys = outboxKeys_();
  const media = opts.payload && opts.payload.media ? opts.payload.media : null;   // {type, file_id, caption}
  if (media && !TG_MEDIA_METHODS[media.type]) throw new SafeError('bad_media_type', 'Недозволений тип медіа: ' + media.type);
  const text = media ? '' : toText_(opts.payload && opts.payload.text);
  const parts = media ? [''] : chunkText_(text, TG_TEXT_LIMIT);
  const created = [];
  const now = nowMs_();
  const due = opts.dueAtMs || now;
  const rows = [];
  parts.forEach(function (part, i) {
    const key = parts.length === 1 ? opts.idempotencyKey : opts.idempotencyKey + '#p' + (i + 1);
    if (keys[key]) return;
    keys[key] = true;
    const payload = media
      ? { method: TG_MEDIA_METHODS[media.type].method, media_type: media.type, file_id: media.file_id, caption: media.caption || undefined }
      : { method: 'sendMessage', text: part };
    if (opts.payload && opts.payload.reply_markup && i === parts.length - 1) payload.reply_markup = opts.payload.reply_markup;
    const meta = Object.assign({ proactive: false, scheduled: false, deferrable: false, orig_due: isoSec_(due) }, opts.meta || {});
    payload.meta = meta;
    rows.push({
      job_id: 'job_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16), idempotency_key: key,
      participant_id: opts.participantId || null, ticket_id: opts.ticketId || null, reply_id: opts.replyId || null,
      recipient_chat_id: String(opts.recipientChatId), message_kind: opts.kind, payload_json: JSON.stringify(payload),
      priority: opts.priority || PRIORITY.DIALOG, schedule_version: opts.scheduleVersion || null,
      created_at: isoSec_(now), due_at: isoSec_(due), status: 'queued', attempt_count: 0, next_attempt_at: null,
      started_at: null, sent_at: null, telegram_message_id: null, last_error_code: null, last_error_note: null,
      operator_action: 'none', post_sent_done: null
    });
  });
  if (rows.length) outbox_().appendMany(rows).forEach(function (r) { created.push(r); });
  return created;
}

function cancelJobs_(pred, reason) {
  const tbl = outbox_();
  let n = 0;
  tbl.rows.forEach(function (j) {
    if ((j.status === 'queued' || j.status === 'retry_wait') && pred(j)) {
      tbl.update(j, { status: 'cancelled', last_error_code: 'cancelled', last_error_note: trunc_(reason || 'скасовано', 200) });
      n++;
    }
  });
  return n;
}
function cancelParticipantJobs_(participantId, reason, onlyProactive) {
  return cancelJobs_(function (j) {
    if (j.participant_id !== participantId) return false;
    if (onlyProactive) return !!(safeJsonParse_(j.payload_json, {}).meta || {}).proactive;
    return true;
  }, reason);
}

// ---------- Режими доставки ----------
function chatAllowed_(chatId, kind, S) {
  const owner = propGet_(PROP.OWNER_CHAT_ID);
  const setup = propGet_(PROP.SETUP_MODE) === 'true';
  if (setup) return kind === 'owner_bind_confirm';       // у SETUP_MODE — лише одноразове підтвердження прив'язки
  if (kind === 'owner_bind_confirm') return true;
  if (OWNER_KINDS.indexOf(kind) >= 0) {
    if (!owner || String(chatId) !== String(owner)) return false;
    // відповіді власнику на його власні команди дозволені завжди; автоматичні сповіщення — лише при DELIVERY_ENABLED
    if (kind === 'owner_status' || kind === 'owner_notice') return true;
    return S.DELIVERY_ENABLED;
  }
  if (S.TEST_CHAT_ALLOWLIST.indexOf(String(chatId)) >= 0) return true;   // allowlist дозволено і при DELIVERY_ENABLED=false
  return S.DELIVERY_ENABLED && !S.TEST_MODE;
}
/** Чи можна ОБРОБЛЯТИ вхідні події цього чату (TEST_MODE / відсутній дозвіл — події лишаються held). */
function inboundAllowed_(chatId, S) {
  const owner = propGet_(PROP.OWNER_CHAT_ID);
  if (owner && String(chatId) === String(owner)) return true;
  if (S.TEST_CHAT_ALLOWLIST.indexOf(String(chatId)) >= 0) return true;
  return S.DELIVERY_ENABLED && !S.TEST_MODE;
}

// ---------- Попередня перевірка завдання ----------
function precheckJob_(job, S, nowMs) {
  const payload = safeJsonParse_(job.payload_json, {});
  const meta = payload.meta || {};
  const isOwner = OWNER_KINDS.indexOf(job.message_kind) >= 0;
  if (isOwner) {
    const owner = propGet_(PROP.OWNER_CHAT_ID);
    if (job.message_kind !== 'owner_bind_confirm' && (!owner || String(job.recipient_chat_id) !== String(owner))) return { action: 'cancel', reason: 'recipient_not_owner' };
    if (job.message_kind === 'owner_alert' && job.participant_id) {
      // сповіщення про тестового учасника власник отримує й при DELIVERY_ENABLED=false (щоб перевірити ланцюг до запуску)
      const tp = table_('PARTICIPANTS').get(job.participant_id);
      if (!tp) return { action: 'cancel', reason: 'participant_gone' };
      if (tp.is_test_record === true) return { action: 'send', payload: payload };
    }
    if (!chatAllowed_(job.recipient_chat_id, job.message_kind, S)) return { action: 'hold' };
    return { action: 'send', payload: payload };
  }
  let p = null;
  if (job.participant_id) {
    p = table_('PARTICIPANTS').get(job.participant_id);
    if (!p) return { action: 'cancel', reason: 'participant_gone' };
    if (String(p.chat_id) !== String(job.recipient_chat_id)) return { action: 'cancel', reason: 'chat_mismatch' };
    if (p.contact_status === 'blocked') return { action: 'cancel', reason: 'blocked' };
    if (p.contact_status === 'opted_out' && meta.proactive) return { action: 'cancel', reason: 'opted_out' };
  }
  if (!chatAllowed_(job.recipient_chat_id, job.message_kind, S)) return { action: 'hold' };
  if (meta.scheduled && p) {
    const stale = jobStillValid_(job, p, meta, S, nowMs);
    if (stale) return { action: 'cancel', reason: stale };
    if (!inWindow_(nowMs, S.TIMEZONE, S.QUIET_ALLOWED_START, S.QUIET_ALLOWED_END)) {
      return { action: 'defer', dueMs: nextWindowMs_(nowMs, S.TIMEZONE, S.QUIET_ALLOWED_START, S.QUIET_ALLOWED_END) };
    }
    if (meta.deferrable) {
      const seen = parseIso_(p.last_seen_at);
      const origDue = parseIso_(meta.orig_due) || nowMs;
      const busy = (seen !== null && nowMs - seen < 10 * 60000) || (p.dialog_type && p.dialog_type !== 'none');
      if (busy && nowMs - origDue < 3 * 3600000) return { action: 'defer', dueMs: nowMs + 10 * 60000 };
    }
  }
  return { action: 'send', payload: payload };
}

// ---------- Доставка ----------
function nextAttemptMs_(attempt, retryAfter, nowMs) {
  const base = BACKOFF_SECONDS[Math.min(Math.max(attempt - 1, 0), BACKOFF_SECONDS.length - 1)];
  const sec = retryAfter ? Math.max(retryAfter, 1) : base;
  return nowMs + sec * 1000;
}

/** Кілька проходів поспіль: післядія доставки (наприклад, сповіщення власнику) може створити нове завдання, яке має піти одразу. */
function deliverOutbox_(budgetEndMs) {
  for (let pass = 0; pass < 3; pass++) {
    const before = G().sends;
    deliverOutboxPass_(budgetEndMs);
    if (G().sends === before) break;
  }
  if (typeof cleanupAcks_ === 'function') cleanupAcks_(settings_());
}

function deliverOutboxPass_(budgetEndMs) {
  const S = settings_();
  const tbl = outbox_();
  const c = G();
  const now0 = nowMs_();
  recoverStaleSending_(now0);
  applyOperatorActions_();
  runPostSentHooks_();
  let rateLimited = false;
  const blockedChats = {};
  const candidates = tbl.rows.filter(function (j) {
    if (j.status !== 'queued' && j.status !== 'retry_wait') return false;
    const due = parseIso_(j.due_at) || 0, na = parseIso_(j.next_attempt_at) || 0;
    return due <= nowMs_() && na <= nowMs_();
  }).sort(function (a, b) {
    return (a.priority - b.priority) || ((parseIso_(a.due_at) || 0) - (parseIso_(b.due_at) || 0)) || (a._row - b._row);
  });
  for (let i = 0; i < candidates.length; i++) {
    if (c.sends >= S.MAX_SENDS_PER_TICK || nowMs_() >= budgetEndMs || rateLimited) break;
    const job = candidates[i];
    if (blockedChats[job.recipient_chat_id]) continue;
    const now = nowMs_();
    const pre = precheckJob_(job, S, now);
    if (pre.action === 'hold') continue;
    if (pre.action === 'cancel') {
      tbl.update(job, { status: 'cancelled', last_error_code: 'cancelled', last_error_note: 'Скасовано: ' + pre.reason });
      continue;
    }
    if (pre.action === 'defer') {
      const pl = safeJsonParse_(job.payload_json, {});
      tbl.update(job, { due_at: isoSec_(pre.dueMs) });
      continue;
    }
    // sending -> зберегти ДО виклику API
    const attempt = (job.attempt_count || 0) + 1;
    tbl.update(job, { status: 'sending', attempt_count: attempt, started_at: isoSec_(now) });
    SpreadsheetApp.flush();
    c.sends++;
    const res = tgSendPayload_(job.recipient_chat_id, pre.payload);
    handleSendResult_(job, res, attempt, S);
    if (res.kind === 'retry' && res.errorCode === 429) rateLimited = true;
    if (!res.ok && res.kind !== 'permanent') blockedChats[job.recipient_chat_id] = true;
  }
}

function handleSendResult_(job, res, attempt, S) {
  const tbl = outbox_();
  const now = nowMs_();
  const c = G();
  const hasHook = !!POST_SENT_HOOKS[job.message_kind];
  if (res.ok) {
    c.metrics.sent++;
    tbl.update(job, {
      status: 'sent', sent_at: isoSec_(now), telegram_message_id: idText_(res.result && res.result.message_id),
      last_error_code: null, last_error_note: null, post_sent_done: hasHook ? false : true
    });
    if (hasHook) runHookForJob_(job);
    return;
  }
  c.metrics.failed++;
  if (res.kind === 'blocked') {
    tbl.update(job, { status: 'failed', last_error_code: 'blocked', last_error_note: 'Користувач заблокував бота або чат недоступний. Дані збережено, доставка в цей чат припинена.' });
    if (job.participant_id) handleBlocked_(job.participant_id);
    return;
  }
  if (res.kind === 'permanent') {
    tbl.update(job, { status: 'failed', last_error_code: 'tg_' + (res.errorCode || 'err'), last_error_note: trunc_('Telegram відхилив запит: ' + res.description + '. Перевірте текст/одержувача; повтор не допоможе без змін.', 300) });
    reportIncident_('outbox', 'permanent_send_error', 'Telegram відхилив відправку (' + res.errorCode + '): ' + res.description, { level: 'error', entityType: 'outbox_job', entityId: job.job_id });
    return;
  }
  if (res.kind === 'unauthorized' || res.kind === 'conflict') {
    tbl.update(job, { status: 'retry_wait', next_attempt_at: isoSec_(now + 300000), last_error_code: res.kind, last_error_note: res.kind === 'unauthorized' ? 'Токен бота недійсний (401). Перевірте BOT_TOKEN.' : 'Конфлікт (409): активний webhook або інший getUpdates.' });
    reportIncident_('telegram', res.kind, res.kind === 'unauthorized' ? 'Telegram повертає 401: перевірте BOT_TOKEN.' : 'Telegram повертає 409: webhook або інший споживач getUpdates.', { level: 'critical', notify: true });
    return;
  }
  if (res.kind === 'retry') {
    c.metrics.retried++;
    if (attempt >= S.MAX_RETRY_ATTEMPTS) {
      tbl.update(job, { status: 'failed', last_error_code: 'retries_exhausted', last_error_note: trunc_('Повторні спроби вичерпано. Остання помилка: ' + res.description + '. Дія: перевірте причину й за потреби виставте operator_action=retry_verified.', 300) });
      reportIncident_('outbox', 'retries_exhausted', 'Повторні спроби доставки вичерпано (' + (res.description || res.errorCode) + ').', { level: 'error', entityType: 'outbox_job', entityId: job.job_id, notify: true });
      return;
    }
    tbl.update(job, { status: 'retry_wait', next_attempt_at: isoSec_(nextAttemptMs_(attempt, res.retryAfter, now)), last_error_code: 'tg_' + (res.errorCode || 'retry'), last_error_note: trunc_('Тимчасова помилка, буде повтор: ' + res.description, 300) });
    return;
  }
  // unknown: запит міг бути прийнятий — без сліпого повтору
  tbl.update(job, {
    status: 'delivery_unknown', last_error_code: 'unknown_outcome',
    last_error_note: 'Невідомо, чи Telegram прийняв повідомлення (' + trunc_(res.description || 'таймаут', 120) + '). Перевірте чат. Якщо повідомлення є — operator_action=mark_delivered_verified, якщо ні — retry_verified.'
  });
  reportIncident_('outbox', 'delivery_unknown', 'Результат відправки невідомий (таймаут або обрив). Перегляньте "Вихідні" зі статусом delivery_unknown.', { level: 'error', notify: true });
}

function recoverStaleSending_(nowMs) {
  const tbl = outbox_();
  tbl.rows.forEach(function (j) {
    if (j.status !== 'sending') return;
    const st = parseIso_(j.started_at) || 0;
    if (nowMs - st > SENDING_STALE_MINUTES * 60000) {
      tbl.update(j, { status: 'delivery_unknown', last_error_code: 'interrupted', last_error_note: 'Відправку перервано (збій чи вичерпання часу). Перевірте чат: якщо повідомлення є — mark_delivered_verified, якщо ні — retry_verified.' });
      reportIncident_('outbox', 'delivery_unknown', 'Відправку перервано посеред виконання; результат невідомий.', { level: 'error', notify: true });
    }
  });
}

function applyOperatorActions_() {
  const tbl = outbox_();
  tbl.rows.forEach(function (j) {
    const a = j.operator_action;
    if (!a || a === 'none') return;
    const now = nowMs_();
    if (a === 'retry_verified' && (j.status === 'delivery_unknown' || j.status === 'failed' || j.status === 'retry_wait')) {
      tbl.update(j, { status: 'queued', next_attempt_at: null, attempt_count: 0, operator_action: 'none', last_error_note: 'Оператор підтвердив: повтор дозволено.' });
    } else if (a === 'mark_delivered_verified' && (j.status === 'delivery_unknown' || j.status === 'failed')) {
      const hasHook = !!POST_SENT_HOOKS[j.message_kind];
      tbl.update(j, { status: 'sent', sent_at: isoSec_(now), operator_action: 'none', post_sent_done: hasHook ? false : true, last_error_note: 'Оператор підтвердив: доставлено.' });
    } else if (a === 'cancel' && j.status !== 'sent') {
      tbl.update(j, { status: 'cancelled', operator_action: 'none', last_error_note: 'Скасовано оператором.' });
    } else {
      tbl.update(j, { operator_action: 'none', last_error_note: trunc_((j.last_error_note || '') + ' [дія ' + a + ' не застосовна до статусу ' + j.status + ']', 300) });
    }
  });
}

// ---------- Післядії після доставки (ідемпотентні; відновлюються, якщо збій стався між sent і ефектом) ----------
const POST_SENT_HOOKS = {
  initial_store_links: 'onStoreLinksSent_',
  day5: 'onDay5Sent_',
  survey_invite: 'onSurveyInviteSent_',
  survey_reminder: 'onSurveyReminderSent_',
  owner_bind_confirm: 'onOwnerBindSent_',
  owner_alert: 'onOwnerAlertSent_',
  support_reply: 'onSupportReplySent_',
  reward_done: 'onRewardNotifySent_',
  survey_question: 'onSurveyPromptSent_'
};
function runHookForJob_(job) {
  const name = POST_SENT_HOOKS[job.message_kind];
  if (!name) return true;
  const fn = (typeof globalThis !== 'undefined') ? globalThis[name] : null;
  if (typeof fn !== 'function') return false;       // модуль етапу 2/3 ще не підключено — завдання лишається незавершеним
  try {
    fn(job);
    outbox_().update(job, { post_sent_done: true });
    return true;
  } catch (e) {
    reportIncident_('outbox', 'post_sent_hook_failed', 'Післядія "' + name + '" не виконана: ' + scrub_(e && e.message), { level: 'error', entityType: 'outbox_job', entityId: job.job_id });
    return false;
  }
}
function runPostSentHooks_() {
  const tbl = outbox_();
  tbl.rows.filter(function (j) { return j.status === 'sent' && j.post_sent_done === false; }).forEach(runHookForJob_);
}

/** Блокування: припинити доставку, дані лишаються. */
function handleBlocked_(participantId) {
  const pt = table_('PARTICIPANTS');
  const p = pt.get(participantId);
  if (!p) return;
  if (p.contact_status !== 'blocked') pt.update(p, { contact_status: 'blocked', blocked_at: nowIso_() });
  cancelParticipantJobs_(participantId, 'Користувач заблокував бота');
}

/** Водяний знак: нижче цього рядка всі завдання фінальні — їх не перечитуємо щотику. */
function advanceOutboxWatermark_() {
  const tbl = outbox_();
  let wm = null;
  for (let i = 0; i < tbl.rows.length; i++) {
    const j = tbl.rows[i];
    // failed лишається у вікні перегляду 7 діб: оператор ще може виставити retry_verified
    const failedOld = j.status === 'failed' && ((nowMs_() - (parseIso_(j.created_at) || 0)) > 7 * 86400000);
    const fin = failedOld || j.status === 'cancelled' || (j.status === 'sent' && j.post_sent_done !== false);
    if (!fin) { wm = j._row; break; }
  }
  if (wm === null) wm = Math.max(tbl.lastDataRow() + 1, 3);
  if (String(wm) !== String(propGet_(PROP.WM_OUTBOX) || '3')) propSet_(PROP.WM_OUTBOX, wm);
}
