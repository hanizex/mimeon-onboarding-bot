/**
 * Participants.gs — реєстрація, стан учасника, місткість, посилання магазинів,
 * вихід/вимкнення повідомлень/видалення даних.
 * Станy розділені: участь, опитування, доступність чату, діалог, винагорода — різні поля.
 */

function participants_() {
  const t = table_('PARTICIPANTS');
  if (!t.loaded) t.load(3);
  return t;
}
function participantByUser_(telegramUserId) {
  const id = String(telegramUserId);
  return participants_().find(function (p) { return String(p.telegram_user_id) === id; });
}
/** MAX_PARTICIPANTS = 0 означає «без обмеження». Ліміт — лише необов'язковий запобіжник. */
function slotsFull_(S) {
  return S.MAX_PARTICIPANTS > 0 && reservedSlotCount_() >= S.MAX_PARTICIPANTS;
}
function reservedSlotCount_() {
  return participants_().filter(function (p) { return p.enrollment_slot_reserved === true && p.is_test_record !== true; }).length;
}

/** Тестовий учасник — лише чат зі списку TEST_CHAT_ALLOWLIST (власник не стає учасником автоматично). */
function isTestChat_(chatId, S) {
  return S.TEST_CHAT_ALLOWLIST.indexOf(String(chatId)) >= 0;
}

/** Створює учасника (один Telegram ID = один учасник). Не вигадує email, телефон, країну, модель пристрою. */
function createParticipant_(from, chatId, S) {
  const test = isTestChat_(chatId, S);
  const hasSlot = test || !slotsFull_(S);
  const row = {
    participant_id: uuid_(), program_id: S.PROGRAM_ID, telegram_user_id: idText_(from.id), chat_id: idText_(chatId),
    first_name: from.first_name || null, last_name: from.last_name || null, username: from.username || null,
    language_code: from.language_code || null, telegram_is_premium: from.is_premium === true ? true : null,
    created_at: nowIso_(), last_seen_at: nowIso_(), consent_version: null, consent_at: null, age_16_confirmed: null,
    platform: null, declared_role: null, campaign_code: S.CAMPAIGN_CODE, store_link_urls_json: null,
    ios_link_tagged: null, android_link_tagged: null, enrollment_slot_reserved: hasSlot,
    participation_status: hasSlot ? 'onboarding' : 'waiting_capacity',
    trial_started_at: null, trial_end_at: null, trial_max_end_at: null, extension_used: false,
    contact_status: 'reachable', reminders_enabled: true, reward_contact_allowed: null, blocked_at: null,
    feedback_received: false, first_feedback_at: null, latest_feedback_at: null, active_survey_id: null,
    schedule_version: 1, day5_sent_at: null, survey_invite_sent_at: null, survey_reminders_sent: 0,
    feedback_collection_deadline: null, dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null,
    internal_notes: null, last_event_id: null, opted_out_at: null, declined_at: null, is_test_record: test ? true : null,
    counted_reminder_jobs: null
  };
  return participants_().append(row);
}

/** Оновлює лише змінені метадані Telegram; відсутні значення не вигадуються. */
function metadataPatch_(p, from) {
  const patch = {};
  if (!from) return patch;
  [['first_name', 'first_name'], ['last_name', 'last_name'], ['username', 'username'], ['language_code', 'language_code']].forEach(function (m) {
    const v = from[m[1]] || null;
    if ((p[m[0]] || null) !== v) patch[m[0]] = v;
  });
  if (from.is_premium === true && p.telegram_is_premium !== true) patch.telegram_is_premium = true;
  return patch;
}

// ---------- Посилання магазинів ----------
function buildStoreLinks_(platform, S) {
  const camp = S.CAMPAIGN_CODE;
  const androidUrl = addQuery_(S.PLAY_STORE_BASE_URL, { utm_source: S.GOOGLE_UTM_SOURCE, utm_medium: S.GOOGLE_UTM_MEDIUM, utm_campaign: camp });
  const token = S.APPLE_PROVIDER_TOKEN;
  const iosTagged = !!token;
  const iosUrl = iosTagged ? addQuery_(S.APP_STORE_BASE_URL, { pt: token, ct: camp, mt: 8 }) : S.APP_STORE_BASE_URL;
  const buttons = [];
  if (platform === 'android' || platform === 'both') buttons.push(['Google Play (Android)', androidUrl]);
  if (platform === 'ios' || platform === 'both') buttons.push(['App Store (iPhone / iPad)', iosUrl]);
  return {
    buttons: buttons,
    urls: { android: (platform === 'ios') ? null : androidUrl, ios: (platform === 'android') ? null : iosUrl },
    androidTagged: platform !== 'ios', iosTagged: platform === 'android' ? null : iosTagged
  };
}

/** Доставлено посилання => старт тесту (один раз) і окрема пам'ятка. Ідемпотентно. */
function onStoreLinksSent_(job) {
  const S = settings_();
  const pt = participants_();
  const p = pt.get(job.participant_id);
  if (!p) return;
  if (!p.trial_started_at && (p.participation_status === 'onboarding')) {
    const startMs = parseIso_(job.sent_at) || nowMs_();
    pt.update(p, {
      trial_started_at: isoSec_(startMs),
      trial_end_at: isoSec_(addLocalDays_(startMs, S.DEFAULT_TRIAL_DAYS, S.TIMEZONE)),
      trial_max_end_at: isoSec_(addLocalDays_(startMs, S.MAX_TRIAL_DAYS, S.TIMEZONE)),
      extension_used: false, participation_status: 'active', schedule_version: 1, survey_reminders_sent: 0
    });
  }
  const fresh = pt.get(job.participant_id);
  if (fresh.trial_started_at) enqueueMemo_(fresh, S, 'starter_memo', fresh.participant_id + ':starter_memo', PRIORITY.DIALOG);
}

function memoText_(p, S) {
  return renderTemplate_('memo', {
    start_date: localDateDots_(parseIso_(p.trial_started_at), S.TIMEZONE),
    end_date: localDateDots_(parseIso_(p.trial_end_at), S.TIMEZONE)
  });
}
function enqueueMemo_(p, S, kind, key, priority) {
  enqueueOutbox_({
    idempotencyKey: key, participantId: p.participant_id, recipientChatId: p.chat_id, kind: kind,
    payload: { text: memoText_(p, S), reply_markup: mainMenuKb_() }, priority: priority || PRIORITY.DIALOG
  });
}

// ---------- Місткість ----------
function promoteWaiting_(S) {
  const pt = participants_();
  let free = S.MAX_PARTICIPANTS > 0 ? S.MAX_PARTICIPANTS - reservedSlotCount_() : 1e9;
  if (free <= 0) return 0;
  const waiting = pt.filter(function (p) { return p.participation_status === 'waiting_capacity' && p.contact_status === 'reachable'; })
    .sort(function (a, b) { return (parseIso_(a.created_at) || 0) - (parseIso_(b.created_at) || 0); });
  let n = 0;
  waiting.forEach(function (p) {
    if (free <= 0) return;
    // повідомлення спершу (ідемпотентний ключ), потім стан
    enqueueOutbox_({
      idempotencyKey: p.participant_id + ':capacity_open', participantId: p.participant_id, recipientChatId: p.chat_id,
      kind: 'capacity_open', payload: { text: renderTemplate_('capacity_open'), reply_markup: kbReply_([[BTN.CONSENT], [BTN.DECLINE]], { oneTime: true }) },
      priority: PRIORITY.DIALOG, meta: { proactive: true }
    });
    pt.update(p, { participation_status: 'onboarding', enrollment_slot_reserved: true });
    free--; n++;
  });
  return n;
}

// ---------- Вихід / вимкнення / відновлення ----------
function proactiveOrOnboardingJob_(j) {
  const meta = safeJsonParse_(j.payload_json, {}).meta || {};
  return !!meta.proactive || !!meta.scheduled || j.message_kind === 'initial_store_links' || j.message_kind === 'starter_memo';
}
function endParticipation_(p) {
  const pt = participants_();
  pt.update(p, { participation_status: 'withdrawn', enrollment_slot_reserved: false, dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null });
  cancelJobs_(function (j) { return j.participant_id === p.participant_id && proactiveOrOnboardingJob_(j); }, 'Участь завершено');
}
function muteParticipant_(p) {
  participants_().update(p, { contact_status: 'opted_out', opted_out_at: nowIso_() });
  cancelParticipantJobs_(p.participant_id, 'Повідомлення вимкнено учасником', true);
}
function unmuteParticipant_(p) {
  participants_().update(p, { contact_status: 'reachable', schedule_version: (p.schedule_version || 1) + 1 });
}
function markUnblocked_(p) {
  participants_().update(p, { contact_status: 'reachable', schedule_version: (p.schedule_version || 1) + 1 });
}

// ---------- Видалення даних ----------
/**
 * Видаляє персональні записи цієї автоматизації, пов'язані з учасником.
 * Порядок: черги/дочірні таблиці → Inbox → Техжурнал → рядок учасника ОСТАННІМ
 * (якщо збій посеред видалення, повтор події завершить роботу, бо учасник ще існує).
 * Повертає {counts, external[]}.
 */
function deleteParticipantData_(p) {
  const pid = p.participant_id;
  const userId = String(p.telegram_user_id), chatId = String(p.chat_id);
  const counts = {};
  const external = [];
  cancelJobs_(function (j) { return j.participant_id === pid; }, 'Видалення даних');

  const tickets = table_('TICKETS').load(3).filter(function (t) { return t.participant_id === pid; });
  const ticketIds = {};
  tickets.forEach(function (t) { ticketIds[t.ticket_id] = true; });

  // зовнішні дії (етап 3): публічна подяка тощо
  const rb = (typeof globalThis !== 'undefined') ? globalThis['rewardsBeforeDelete_'] : null;
  if (typeof rb === 'function') {
    const ext = rb(p);
    if (ext && ext.length) ext.forEach(function (x) { external.push(x); });
  }
  counts.replies = table_('REPLIES').deleteWhere(function (r) { return !!ticketIds[r.ticket_id]; });
  counts.messages = table_('MESSAGES').deleteWhere(function (m) { return m.participant_id === pid || (m.ticket_id && ticketIds[m.ticket_id]); });
  counts.attachments = table_('ATTACHMENTS').deleteWhere(function (a) { return a.participant_id === pid; });
  counts.answers = table_('ANSWERS').deleteWhere(function (a) { return a.participant_id === pid; });
  counts.surveys = table_('SURVEYS').deleteWhere(function (s) { return s.participant_id === pid; });
  counts.rewards = table_('REWARDS').deleteWhere(function (r) { return r.participant_id === pid; });
  counts.tickets = table_('TICKETS').deleteWhere(function (t) { return t.participant_id === pid; });
  counts.outbox = table_('OUTBOX').deleteWhere(function (j) { return j.participant_id === pid || (j.ticket_id && ticketIds[j.ticket_id]) || String(j.recipient_chat_id) === chatId; });
  counts.inbox = table_('INBOX').deleteWhere(function (e) { return String(e.telegram_user_id) === userId || String(e.chat_id) === chatId; });
  counts.techlog = table_('TECHLOG').deleteWhere(function (r) { return r.related_entity_id === pid || (r.related_entity_id && ticketIds[r.related_entity_id]); });
  counts.participant = participants_().deleteWhere(function (x) { return x.participant_id === pid; });

  // після видалення рядків позиції змінилися — скидаємо водяні знаки й кеші
  propSet_(PROP.WM_INBOX, 3);
  propSet_(PROP.WM_OUTBOX, 3);
  const c = G();
  c.outboxKeys = null;
  ['OUTBOX', 'INBOX'].forEach(function (k) { if (c.tables[k]) { c.tables[k].loaded = false; } });
  if (c.tables.TECHLOG) { c.tables.TECHLOG._incidentWindowLoaded = false; c.tables.TECHLOG.loaded = false; }
  return { counts: counts, external: external };
}

function deleteSummaryText_(counts) {
  const parts = ['профіль учасника'];
  if (counts.tickets) parts.push('звернень: ' + counts.tickets);
  if (counts.messages) parts.push('повідомлень у зверненнях: ' + counts.messages);
  if (counts.replies) parts.push('відповідей команди: ' + counts.replies);
  if (counts.attachments) parts.push('вкладень: ' + counts.attachments);
  if (counts.surveys) parts.push('анкет: ' + counts.surveys);
  if (counts.answers) parts.push('відповідей анкети: ' + counts.answers);
  if (counts.rewards) parts.push('записів про подяку: ' + counts.rewards);
  return parts.join('; ');
}
