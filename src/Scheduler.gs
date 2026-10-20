/**
 * Scheduler.gs — календарні дні (Europe/Kyiv), вікно 10:00–20:00, нагадування, продовження, завершення збору.
 *
 * Принципи:
 *  - усі дати рахуються календарними днями за часовим поясом (не фіксований UTC+2/+3);
 *  - завдання ставляться наперед ідемпотентно (ключ = participant_id + тип + schedule_version);
 *  - актуальність перевіряється ПЕРЕД відправкою (jobStillValid_): простій не породжує пачку застарілих нагадувань;
 *  - зміна schedule_version (продовження, розблокування) робить усі старі планові завдання недійсними.
 */

function canExtend_(p, S, nowMs) {
  if (!p.trial_started_at || p.extension_used === true) return false;
  if (['active', 'awaiting_feedback'].indexOf(p.participation_status) < 0) return false;
  const max = parseIso_(p.trial_max_end_at);
  if (max === null || nowMs >= max) return false;
  if (surveyIsCompleted_(p.participant_id)) return false;
  return true;
}

/**
 * "Ще тиждень": нова кінцева дата = trial_started_at + MAX_TRIAL_DAYS (не дата натискання + 7).
 * Нове фінальне запрошення — на D21; дедлайн збору переноситься на 7 днів після його ФАКТИЧНОЇ доставки.
 * Лічильник нагадувань НЕ скидається.
 */
function applyExtension_(p, S, nowMs, extraPatch) {
  if (!canExtend_(p, S, nowMs)) return false;
  const newVersion = (p.schedule_version || 1) + 1;
  const patch = {
    extension_used: true, trial_end_at: p.trial_max_end_at, schedule_version: newVersion,
    survey_invite_sent_at: null, feedback_collection_deadline: null, participation_status: 'active'
  };
  if (extraPatch) Object.keys(extraPatch).forEach(function (k) { patch[k] = extraPatch[k]; });
  participants_().update(p, patch);
  cancelJobs_(function (j) {
    const meta = safeJsonParse_(j.payload_json, {}).meta || {};
    return j.participant_id === p.participant_id && meta.scheduled && (j.schedule_version || 0) < newVersion;
  }, 'Продовження: розклад перераховано');
  return true;
}

function finishParticipation_(p, reason) {
  const pt = participants_();
  if (p.participation_status !== 'withdrawn' && p.participation_status !== 'finished') pt.update(p, { participation_status: 'finished' });
  cancelJobs_(function (j) {
    const meta = safeJsonParse_(j.payload_json, {}).meta || {};
    return j.participant_id === p.participant_id && meta.scheduled;
  }, reason || 'Участь завершено');
}

function schedKb_(kind, p, S, nowMs) {
  const rows = [[BTN.GIVE_FEEDBACK]];
  if (kind === 'survey_invite' && canExtend_(p, S, nowMs)) rows[0].push(BTN.EXTEND);
  rows.push([BTN.STOP_REMINDERS]);
  rows.push([BTN.MENU_DATA]);
  return kbReply_(rows);
}

function enqueueScheduled_(p, S, kind, dueMs, tag) {
  const sv = p.schedule_version || 1;
  if (outboxKeys_()[p.participant_id + ':' + tag + ':v' + sv]) return;     // вже поставлено (будь-який статус)
  const text = renderTemplate_(kind === 'day5' ? 'day5' : (kind === 'survey_invite' ? 'survey_invite' : 'survey_reminder'));
  const payload = { text: text };
  if (kind !== 'day5') payload.reply_markup = schedKb_(kind, p, S, nowMs_());
  else payload.reply_markup = mainMenuKb_();
  enqueueOutbox_({
    idempotencyKey: p.participant_id + ':' + tag + ':v' + sv, participantId: p.participant_id, recipientChatId: p.chat_id,
    kind: kind, payload: payload, priority: PRIORITY.SCHEDULED, scheduleVersion: sv, dueAtMs: dueMs,
    meta: { proactive: true, scheduled: true, deferrable: true }
  });
}

function runScheduler_(S) {
  const now = nowMs_();
  promoteWaiting_(S);
  const pt = participants_();
  pt.rows.slice().forEach(function (p) {
    if (!p.trial_started_at) return;
    if (['active', 'awaiting_feedback'].indexOf(p.participation_status) < 0) return;
    try { planParticipant_(p, S, now); }
    catch (e) { reportIncident_('scheduler', 'plan_failed', 'Не вдалося перерахувати розклад: ' + scrub_(e && e.message), { level: 'error', entityType: 'participant', entityId: p.participant_id }); }
  });
}

function planParticipant_(p, S, now) {
  const tz = S.TIMEZONE, pid = p.participant_id, sv = p.schedule_version || 1;
  const start = parseIso_(p.trial_started_at), end = parseIso_(p.trial_end_at);
  if (start === null || end === null) return;
  if (surveyIsCompleted_(pid)) { finishParticipation_(p, 'Анкету завершено'); return; }
  const deadline = parseIso_(p.feedback_collection_deadline);
  if (p.survey_invite_sent_at && deadline !== null && now >= deadline) {
    surveyCloseCollection_(p);
    finishParticipation_(p, 'Автоматичний збір завершено');
    return;
  }
  if (p.contact_status !== 'reachable') return;
  // День 5 — лише в початковому розкладі й до завершення тесту
  if (sv === 1 && !p.day5_sent_at && now < end) {
    const d5 = nextWindowMs_(addLocalDays_(start, S.DAY5_NUDGE_DAY, tz), tz, S.QUIET_ALLOWED_START, S.QUIET_ALLOWED_END);
    if (d5 < end) enqueueScheduled_(p, S, 'day5', d5, 'day5');
  }
  // Фінальне запрошення
  if (!p.survey_invite_sent_at) {
    enqueueScheduled_(p, S, 'survey_invite', nextWindowMs_(end, tz, S.QUIET_ALLOWED_START, S.QUIET_ALLOWED_END), 'survey_invite');
    return;
  }
  // Нагадування після ДОСТАВЛЕНОГО запрошення
  if (p.reminders_enabled === false) return;
  const sentMs = parseIso_(p.survey_invite_sent_at);
  const keys = outboxKeys_();
  const pending = outbox_().filter(function (j) {
    return j.participant_id === pid && j.message_kind === 'survey_reminder' && (j.status === 'queued' || j.status === 'retry_wait' || j.status === 'sending');
  }).length;
  let budget = S.MAX_SURVEY_REMINDERS - (p.survey_reminders_sent || 0) - pending;
  S.SURVEY_REMINDER_OFFSETS.forEach(function (off, i) {
    const key = pid + ':reminder' + (i + 1) + ':v' + sv;
    if (keys[key] || budget <= 0) return;
    const due = nextWindowMs_(addLocalDays_(sentMs, off, tz), tz, S.QUIET_ALLOWED_START, S.QUIET_ALLOWED_END);
    if (deadline !== null && due >= deadline) return;
    enqueueScheduled_(p, S, 'survey_reminder', due, 'reminder' + (i + 1));
    budget--;
  });
}

/** Повертає причину скасування або null. Викликається перед кожною відправкою планового завдання. */
function jobStillValid_(job, p, meta, S, now) {
  if (p.participation_status === 'withdrawn' || p.participation_status === 'finished' || p.participation_status === 'waiting_capacity') return 'participation_ended';
  if ((job.schedule_version || 1) !== (p.schedule_version || 1)) return 'stale_version';
  const kind = job.message_kind;
  if (kind === 'day5') {
    if (p.day5_sent_at) return 'already_sent';
    const end = parseIso_(p.trial_end_at);
    if (end !== null && now >= end) return 'trial_ended';   // день 5 після завершення тесту пропускається
    return null;
  }
  if (kind === 'survey_invite') {
    if (p.survey_invite_sent_at) return 'already_sent';
    if (surveyIsCompleted_(p.participant_id)) return 'survey_completed';
    return null;
  }
  if (kind === 'survey_reminder') {
    if (p.reminders_enabled === false) return 'reminders_off';
    if (surveyIsCompleted_(p.participant_id)) return 'survey_completed';
    const dl = parseIso_(p.feedback_collection_deadline);
    if (dl !== null && now >= dl) return 'collection_closed';
    if ((p.survey_reminders_sent || 0) >= S.MAX_SURVEY_REMINDERS) return 'quota_reached';
    // згортання: якщо прострочено кілька нагадувань — надсилаємо лише останнє
    const myDue = parseIso_(job.due_at) || 0;
    const later = outbox_().find(function (j) {
      return j !== job && j.participant_id === p.participant_id && j.message_kind === 'survey_reminder' &&
        (j.status === 'queued' || j.status === 'retry_wait') && (j.schedule_version || 1) === (job.schedule_version || 1) &&
        (parseIso_(j.due_at) || 0) > myDue && (parseIso_(j.due_at) || 0) <= now;
    });
    if (later) return 'collapsed_stale';
    return null;
  }
  return null;
}

// ---------- Післядії доставки ----------
function onDay5Sent_(job) {
  const pt = participants_();
  const p = pt.get(job.participant_id);
  if (!p) return;
  if (!p.day5_sent_at) pt.update(p, { day5_sent_at: job.sent_at });
}
function onSurveyInviteSent_(job) {
  const S = settings_();
  const pt = participants_();
  const p = pt.get(job.participant_id);
  if (!p) return;
  if ((job.schedule_version || 1) !== (p.schedule_version || 1)) return;     // застаріле запрошення (розклад уже змінено)
  if (p.survey_invite_sent_at) return;
  const sentMs = parseIso_(job.sent_at) || nowMs_();
  pt.update(p, {
    survey_invite_sent_at: isoSec_(sentMs),
    feedback_collection_deadline: isoSec_(addLocalDays_(sentMs, S.FEEDBACK_WINDOW_DAYS, S.TIMEZONE)),
    participation_status: p.participation_status === 'active' ? 'awaiting_feedback' : p.participation_status
  });
}
function onSurveyReminderSent_(job) {
  const pt = participants_();
  const p = pt.get(job.participant_id);
  if (!p) return;
  const counted = parseList_(p.counted_reminder_jobs);
  if (counted.indexOf(job.job_id) >= 0) return;          // ідемпотентність: одна доставка = один інкремент
  counted.push(job.job_id);
  pt.update(p, { survey_reminders_sent: (p.survey_reminders_sent || 0) + 1, counted_reminder_jobs: counted.join(',') });
}
