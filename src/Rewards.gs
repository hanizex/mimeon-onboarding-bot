/**
 * Rewards.gs — подяки після релізу (розділ 8 вимог).
 *
 * Правила:
 *  - право виникає за сам ФАКТ фідбеку (відповідь анкети, "Не пам'ятаю", опис проблеми); позитивність не потрібна;
 *  - одне право на учасника (reward_id від participant_id); повторний фідбек другого права не створює;
 *  - вибір одного з трьох можна змінити або скасувати до фактичного виконання;
 *  - видача не починається, доки RELEASE_CONFIRMED=false (EXPECTED_RELEASE_MONTH — лише очікування);
 *  - fulfilled = фактичне виконання (активація / публікація / доставка звіту), а не "обіцянка надіслана";
 *  - повідомлення про виконання — лише за окремою згодою reward_contact_allowed і не вимкненим учасником каналом.
 */

const REWARD_DIALOGS = ['reward_choice', 'reward_email', 'reward_public_name'];

function rewards_() {
  const t = table_('REWARDS');
  if (!t.loaded) t.load(3);
  return t;
}
function rewardIdFor_(participantId) { return 'rw_' + sha256Hex_('reward|' + participantId).slice(0, 12); }
function rewardOf_(participantId) { return rewards_().get(rewardIdFor_(participantId)); }

/** Створює єдиний запис права (ідемпотентно). Викликається, коли з'являється фідбек. */
function ensureRewardEligibility_(p, srcType, srcId, atIso) {
  const id = rewardIdFor_(p.participant_id);
  if (rewards_().get(id)) return rewards_().get(id);
  return rewards_().append({
    reward_id: id, participant_id: p.participant_id, eligible_at: atIso || nowIso_(), eligibility_source_type: srcType || null, eligibility_source_id: srcId || null,
    reward_choice: null, choice_at: null, contact_allowed: null, email: null, account_match_status: null, public_display_name: null, public_profile_url: null,
    publication_consent_at: null, public_entry_id: null, status: 'eligible_unselected', fulfilled_at: null, premium_activated_at: null, premium_expires_at: null,
    report_version: null, public_thanks_url: null, notification_status: null, internal_notes: null
  });
}

function rewardChoiceTitle_(c) {
  return ({ premium_month: 'Місяць преміуму', research_results: 'Результати тестування', public_thanks: 'Публічна подяка' })[c] || '—';
}
function rewardStatusText_(r, S) {
  if (r.status === 'fulfilled') return 'виконано';
  if (r.status === 'cancelled_by_user') return 'скасовано';
  if (r.status === 'eligible_unselected') return 'вибір ще не зроблено';
  return S.RELEASE_CONFIRMED ? 'готуємо видачу' : 'очікує релізу (орієнтир — ' + S.EXPECTED_RELEASE_MONTH + ')';
}
function rewardChooseKb_() { return kbReply_([[BTN.REWARD_PREMIUM], [BTN.REWARD_RESEARCH], [BTN.REWARD_PUBLIC], [BTN.CANCEL]]); }
function rewardCtx_(p) { return dialogCtx_(p); }
function rewardSetCtx_(t, dialogType, ctx) { t.set({ dialog_type: dialogType, dialog_ref_id: null, dialog_context_json: jsonStr_(ctx) }); }

// ---------- Меню "Моя подяка" ----------
function onMenuReward_(t) {
  const p = t.p, S = t.S;
  const r = rewardOf_(p.participant_id);
  if (!r) { t.say('rw_none', renderTemplate_('reward_not_eligible')); return true; }
  if (r.status === 'fulfilled') { t.say('rw_done', renderTemplate_('reward_current_fulfilled', { choice: rewardChoiceTitle_(r.reward_choice) })); return true; }
  if (r.reward_choice && r.status !== 'cancelled_by_user' && r.status !== 'eligible_unselected') {
    rewardSetCtx_(t, 'reward_choice', { step: 'current' });
    t.say('rw_cur', renderTemplate_('reward_current', { choice: rewardChoiceTitle_(r.reward_choice), status: rewardStatusText_(r, S) }),
      kbReply_([[BTN.REWARD_CHANGE], [BTN.REWARD_CANCEL], [BTN.BACK]]));
    return true;
  }
  rewardSetCtx_(t, 'reward_choice', { step: 'choose' });
  t.say('rw_choose', renderTemplate_('reward_choose', { release: S.EXPECTED_RELEASE_MONTH }), rewardChooseKb_());
  return true;
}

function rewardLeave_(t, tag, text) {
  t.set(clearDialogPatch_());
  t.say(tag, text, mainMenuKb_());
  return true;
}

function onDialogMessageReward_(t) {
  const p = t.p, S = t.S;
  const ctx = rewardCtx_(p);
  const r = rewardOf_(p.participant_id);
  if (!r) return rewardLeave_(t, 'rw_none', renderTemplate_('reward_not_eligible'));
  if (r.status === 'fulfilled') return rewardLeave_(t, 'rw_done', renderTemplate_('reward_current_fulfilled', { choice: rewardChoiceTitle_(r.reward_choice) }));
  const text = normText_(t.pl.message.text);
  const raw = toText_(t.pl.message.text).trim();
  const step = ctx.step || 'choose';

  if (p.dialog_type === 'reward_email') return rewardEmail_(t, ctx, raw, text);
  if (p.dialog_type === 'reward_public_name') return step === 'url' ? rewardUrl_(t, ctx, raw, text) : rewardName_(t, ctx, raw, text);

  if (step === 'current') {
    if (btnIs_(text, BTN.REWARD_CHANGE)) {
      rewardSetCtx_(t, 'reward_choice', { step: 'choose' });
      t.say('rw_choose', renderTemplate_('reward_choose', { release: S.EXPECTED_RELEASE_MONTH }), rewardChooseKb_());
      return true;
    }
    if (btnIs_(text, BTN.REWARD_CANCEL)) {
      rewards_().update(r, {
        status: 'cancelled_by_user', reward_choice: null, choice_at: null, contact_allowed: null, email: null, account_match_status: null,
        public_display_name: null, public_profile_url: null, publication_consent_at: null, notification_status: null
      });
      return rewardLeave_(t, 'rw_cancel', renderTemplate_('reward_cancelled'));
    }
    if (btnIs_(text, BTN.BACK) || btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'menu', renderTemplate_('menu_back'));
    t.say('rw_cur', renderTemplate_('reward_current', { choice: rewardChoiceTitle_(r.reward_choice), status: rewardStatusText_(r, S) }),
      kbReply_([[BTN.REWARD_CHANGE], [BTN.REWARD_CANCEL], [BTN.BACK]]));
    return true;
  }
  if (step === 'choose') {
    if (btnIs_(text, BTN.CANCEL) || btnIs_(text, BTN.BACK)) return rewardLeave_(t, 'menu', renderTemplate_('menu_back'));
    if (btnIs_(text, BTN.REWARD_PREMIUM)) {
      rewardSetCtx_(t, 'reward_email', { step: 'email', choice: 'premium_month' });
      t.say('rw_email', renderTemplate_('reward_email_prompt'), kbReply_([[BTN.CANCEL]]));
      return true;
    }
    if (btnIs_(text, BTN.REWARD_RESEARCH)) {
      rewardSetCtx_(t, 'reward_choice', { step: 'contact', choice: 'research_results' });
      t.say('rw_contact', renderTemplate_('reward_contact_consent'), kbReply_([[BTN.REWARD_YES_CONTACT], [BTN.REWARD_NO_CONTACT]], { oneTime: true }));
      return true;
    }
    if (btnIs_(text, BTN.REWARD_PUBLIC)) {
      rewardSetCtx_(t, 'reward_public_name', { step: 'name', choice: 'public_thanks' });
      t.say('rw_name', renderTemplate_('reward_name_prompt'), kbReply_([[BTN.CANCEL]]));
      return true;
    }
    t.say('rw_choose', renderTemplate_('reward_choose', { release: S.EXPECTED_RELEASE_MONTH }), rewardChooseKb_());
    return true;
  }
  if (step === 'publish') {
    if (btnIs_(text, BTN.REWARD_YES_PUBLISH)) {
      rewardSetCtx_(t, 'reward_choice', Object.assign({}, ctx, { step: 'contact', publish_at: isoSec_(Math.min((t.pl.message.date || 0) * 1000 || t.now, t.now)) }));
      t.say('rw_contact', renderTemplate_('reward_contact_consent'), kbReply_([[BTN.REWARD_YES_CONTACT], [BTN.REWARD_NO_CONTACT]], { oneTime: true }));
      return true;
    }
    if (btnIs_(text, BTN.REWARD_NO_PUBLISH) || btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'rw_nopub', renderTemplate_('reward_publish_declined'));
    t.say('rw_publish', renderTemplate_('reward_publish_consent', { name: ctx.name, url: ctx.url ? ' з посиланням ' + ctx.url : '' }), kbReply_([[BTN.REWARD_YES_PUBLISH], [BTN.REWARD_NO_PUBLISH]], { oneTime: true }));
    return true;
  }
  if (step === 'contact') {
    const yes = btnIs_(text, BTN.REWARD_YES_CONTACT), no = btnIs_(text, BTN.REWARD_NO_CONTACT);
    if (btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'rw_cancelled', renderTemplate_('support_cancelled'));
    if (!yes && !no) {
      t.say('rw_contact', renderTemplate_('reward_contact_consent'), kbReply_([[BTN.REWARD_YES_CONTACT], [BTN.REWARD_NO_CONTACT]], { oneTime: true }));
      return true;
    }
    return rewardFinalize_(t, r, ctx, yes);
  }
  return rewardLeave_(t, 'menu', renderTemplate_('menu_back'));
}

function rewardEmail_(t, ctx, raw, text) {
  if (btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'rw_cancelled', renderTemplate_('support_cancelled'));
  if (!isValidEmail_(raw)) { t.say('rw_email_bad', renderTemplate_('reward_email_invalid'), kbReply_([[BTN.CANCEL]])); return true; }
  rewardSetCtx_(t, 'reward_choice', { step: 'contact', choice: 'premium_month', email: raw.trim() });
  t.say('rw_contact', renderTemplate_('reward_contact_consent'), kbReply_([[BTN.REWARD_YES_CONTACT], [BTN.REWARD_NO_CONTACT]], { oneTime: true }));
  return true;
}

function rewardName_(t, ctx, raw, text) {
  if (btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'rw_cancelled', renderTemplate_('support_cancelled'));
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60 || /https?:|www\.|@|[<>]/i.test(name) || (t.pl.message.attachments || []).length) {
    t.say('rw_name_bad', renderTemplate_('reward_name_invalid'), kbReply_([[BTN.CANCEL]]));
    return true;
  }
  rewardSetCtx_(t, 'reward_public_name', { step: 'url', choice: 'public_thanks', name: name });
  t.say('rw_url', renderTemplate_('reward_url_prompt'), kbReply_([[BTN.REWARD_NO_URL], [BTN.CANCEL]]));
  return true;
}

function rewardUrl_(t, ctx, raw, text) {
  if (btnIs_(text, BTN.CANCEL)) return rewardLeave_(t, 'rw_cancelled', renderTemplate_('support_cancelled'));
  let url = null;
  if (!btnIs_(text, BTN.REWARD_NO_URL)) {
    if (!/^https:\/\/[^\s<>"']{3,300}$/.test(raw)) { t.say('rw_url_bad', renderTemplate_('reward_url_invalid'), kbReply_([[BTN.REWARD_NO_URL], [BTN.CANCEL]])); return true; }
    url = raw;
  }
  rewardSetCtx_(t, 'reward_choice', { step: 'publish', choice: 'public_thanks', name: ctx.name, url: url });
  t.say('rw_publish', renderTemplate_('reward_publish_consent', { name: ctx.name, url: url ? ' з посиланням ' + url : '' }), kbReply_([[BTN.REWARD_YES_PUBLISH], [BTN.REWARD_NO_PUBLISH]], { oneTime: true }));
  return true;
}

/** Єдиний запис вибору. Поля, що не стосуються обраного варіанта, очищаються (мінімізація даних). */
function rewardFinalize_(t, r, ctx, contactAllowed) {
  const S = t.S;
  const choice = ctx.choice;
  const m = t.pl.message;
  const at = isoSec_(Math.min(m.date ? m.date * 1000 : t.now, t.now));
  const patch = {
    reward_choice: choice, choice_at: at, contact_allowed: contactAllowed === true,
    email: choice === 'premium_month' ? ctx.email : null,
    account_match_status: choice === 'premium_month' ? 'unknown' : null,
    public_display_name: choice === 'public_thanks' ? ctx.name : null,
    public_profile_url: choice === 'public_thanks' ? (ctx.url || null) : null,
    publication_consent_at: choice === 'public_thanks' ? (ctx.publish_at || null) : null,
    status: S.RELEASE_CONFIRMED ? 'pending_fulfillment' : 'pending_release',
    notification_status: null
  };
  if (choice === 'public_thanks' && !patch.publication_consent_at) {          // без явної згоди публікація неможлива
    return rewardLeave_(t, 'rw_nopub', renderTemplate_('reward_publish_declined'));
  }
  if (choice !== 'premium_month' || r.reward_choice !== 'premium_month') {      // зміна варіанта: службові поля команди не переносяться
    patch.premium_activated_at = null; patch.premium_expires_at = null;
  }
  if (r.reward_choice !== choice) { patch.public_entry_id = null; patch.public_thanks_url = null; patch.report_version = null; }
  rewards_().update(r, patch);
  t.set(Object.assign(clearDialogPatch_(), { reward_contact_allowed: contactAllowed === true }));
  t.say('rw_saved', renderTemplate_(contactAllowed ? 'reward_saved' : 'reward_saved_no_contact', { choice: rewardChoiceTitle_(choice) }), mainMenuKb_());
  return true;
}

// ---------- Видача після релізу ----------
/** Як reportIncident_, але без запису на кожному tick: якщо така відкрита проблема вже є — нічого не змінюємо. */
function reportIncidentOnce_(component, code, summary, opts) {
  opts = opts || {};
  try {
    const tbl = table_('TECHLOG');
    if (!tbl._incidentWindowLoaded) { tbl.load(Math.max(3, tbl.lastDataRow() - 499)); tbl._incidentWindowLoaded = true; }
    const entityId = toText_(opts.entityId);
    const ex = tbl.find(function (r) { return r.component === component && r.error_code === code && toText_(r.related_entity_id) === entityId && r.state === 'open'; });
    if (ex) return ex;
  } catch (e) { /* журнал не повинен ламати основний процес */ }
  return reportIncident_(component, code, summary, opts);
}

function rewardNotifyText_(r, S) {
  const tz = S.TIMEZONE;
  if (r.reward_choice === 'premium_month') {
    const from = parseFlexDate_(r.premium_activated_at, tz), to = parseFlexDate_(r.premium_expires_at, tz);
    return renderTemplate_('reward_done_premium', { from: localDateDots_(from, tz), to: localDateDots_(to, tz) });
  }
  if (r.reward_choice === 'public_thanks') return renderTemplate_('reward_done_public', { url: r.public_thanks_url });
  return null;
}

function reportTextForVersion_(S) {
  const rows = table_('REPORT').load(3).rows.filter(function (b) { return b.approved === true && b.text && Number(b.report_version) === Number(S.REPORT_VERSION); });
  rows.sort(function (a, b) { return (a.order || 0) - (b.order || 0) || a._row - b._row; });
  if (!rows.length) return { text: null, reason: 'no_blocks' };
  const text = rows.map(function (b) { return (b.section ? b.section + '\n' : '') + b.text; }).join('\n\n');
  if (/[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/.test(text) || /\d{8,}/.test(text) || /t\.me\//i.test(text)) return { text: null, reason: 'possible_personal_data' };
  return { text: text, reason: null };
}

function enqueueRewardNotice_(r, p, text, kind) {
  enqueueOutbox_({
    idempotencyKey: 'reward_done:' + r.reward_id + ':' + r.reward_choice + (kind === 'research' ? ':v' + Number(r.report_version || 0) : ''),
    participantId: p.participant_id, recipientChatId: p.chat_id, kind: 'reward_done', payload: { text: text, reply_markup: mainMenuKb_() },
    priority: PRIORITY.REWARD_DONE, meta: { proactive: true, reward_id: r.reward_id }
  });
}

function rewardCanNotify_(r, p) {
  return r.contact_allowed === true && p.reward_contact_allowed === true && p.contact_status === 'reachable';
}

/** Щотіку: статуси за RELEASE_CONFIRMED; видача за фактичною готовністю; стан повідомлень. */
function rewardsHousekeeping_(S) {
  const tbl = rewards_();
  if (!tbl.rows.length) return;
  tbl.rows.slice().forEach(function (r) {
    if (!r.reward_choice || r.status === 'cancelled_by_user' || r.status === 'eligible_unselected') return;
    try { rewardProcess_(r, S); }
    catch (e) { reportIncident_('rewards', 'process_failed', 'Не вдалося обробити подяку: ' + trunc_(scrub_(e && e.message), 200), { level: 'error', entityType: 'reward', entityId: r.reward_id }); }
  });
  rewardSyncNotifications_();
}

function rewardProcess_(r, S) {
  const tbl = rewards_();
  const tz = S.TIMEZONE;
  if (r.status !== 'fulfilled') {
    const want = S.RELEASE_CONFIRMED ? 'pending_fulfillment' : 'pending_release';
    if (r.status !== want) r = tbl.update(r, { status: want });
  }
  if (!S.RELEASE_CONFIRMED) return;                              // дата релізу сама нічого не запускає
  const p = participants_().get(r.participant_id);
  if (!p) return;

  if (r.reward_choice === 'premium_month') {
    if (!r.premium_activated_at) return;
    const act = parseFlexDate_(r.premium_activated_at, tz);
    if (act === null) { reportIncidentOnce_('rewards', 'bad_activation_date', 'Не розібрано дату premium_activated_at (формат РРРР-ММ-ДД).', { level: 'warn', entityType: 'reward', entityId: r.reward_id }); return; }
    const patch = {};
    const exp = parseFlexDate_(r.premium_expires_at, tz);
    if (exp === null) patch.premium_expires_at = isoSec_(addLocalMonths_(act, 1, tz));
    if (r.status !== 'fulfilled') { patch.status = 'fulfilled'; patch.fulfilled_at = isoSec_(nowMs_()); }
    if (Object.keys(patch).length) r = tbl.update(r, patch);
    rewardNotifyOnce_(r, p, S, 'premium');
    return;
  }
  if (r.reward_choice === 'public_thanks') {
    if (!r.public_thanks_url) return;
    if (!r.publication_consent_at || !r.public_display_name) {
      reportIncidentOnce_('rewards', 'publish_without_consent', 'Для публічної подяки внесено URL, але немає згоди на публікацію або імені. Видачу не позначено виконаною.', { level: 'warn', entityType: 'reward', entityId: r.reward_id });
      return;
    }
    if (!/^https:\/\/[^\s<>"']{3,300}$/.test(r.public_thanks_url)) {
      reportIncidentOnce_('rewards', 'bad_public_url', 'public_thanks_url має починатися з https://.', { level: 'warn', entityType: 'reward', entityId: r.reward_id });
      return;
    }
    if (r.status !== 'fulfilled') r = tbl.update(r, { status: 'fulfilled', fulfilled_at: isoSec_(nowMs_()) });
    rewardNotifyOnce_(r, p, S, 'public');
    return;
  }
  if (r.reward_choice === 'research_results') {
    if (r.status === 'fulfilled' || !S.REPORT_READY) return;
    if (!rewardCanNotify_(r, p)) return;                          // без згоди на доставку звіт не надсилається
    const rep = reportTextForVersion_(S);
    if (!rep.text) {
      if (rep.reason === 'possible_personal_data') reportIncidentOnce_('rewards', 'report_personal_data', 'У затверджених блоках звіту схоже на персональні дані (email, довгі числа, t.me). Звіт не надіслано: знеособте текст.', { level: 'warn', entityType: 'report', entityId: 'v' + S.REPORT_VERSION });
      else reportIncidentOnce_('rewards', 'report_empty', 'REPORT_READY=true, але немає затверджених блоків для REPORT_VERSION=' + S.REPORT_VERSION + '.', { level: 'warn', entityType: 'report', entityId: 'v' + S.REPORT_VERSION });
      return;
    }
    if (r.report_version === null || Number(r.report_version) !== Number(S.REPORT_VERSION)) r = tbl.update(r, { report_version: String(S.REPORT_VERSION) });
    enqueueRewardNotice_(r, p, renderTemplate_('reward_done_research', { report: rep.text }), 'research');
    if (!r.notification_status) tbl.update(r, { notification_status: 'queued' });
  }
}

function rewardNotifyOnce_(r, p, S, kind) {
  if (r.notification_status) return;
  if (!rewardCanNotify_(r, p)) { rewards_().update(r, { notification_status: 'not_allowed' }); return; }
  enqueueRewardNotice_(r, p, rewardNotifyText_(r, S), kind);
  rewards_().update(r, { notification_status: 'queued' });
}

/** Післядія доставки повідомлення про виконання. Для звіту доставка і є виконанням. */
function onRewardNotifySent_(job) {
  const meta = (safeJsonParse_(job.payload_json, {}) || {}).meta || {};
  const r = meta.reward_id ? rewards_().get(meta.reward_id) : null;
  if (!r) return;
  const patch = { notification_status: 'sent' };
  if (r.reward_choice === 'research_results' && r.status !== 'fulfilled') { patch.status = 'fulfilled'; patch.fulfilled_at = job.sent_at || nowIso_(); }
  rewards_().update(r, patch);
}

/** Невдалі/невизначені повідомлення видно в самій винагороді. */
function rewardSyncNotifications_() {
  const jobs = outbox_().rows.filter(function (j) { return j.message_kind === 'reward_done'; });
  if (!jobs.length) return;
  jobs.forEach(function (j) {
    const meta = (safeJsonParse_(j.payload_json, {}) || {}).meta || {};
    const r = meta.reward_id ? rewards_().get(meta.reward_id) : null;
    if (!r || r.notification_status === 'sent') return;
    let want = null;
    if (j.status === 'failed' || j.status === 'cancelled') want = 'failed';
    else if (j.status === 'delivery_unknown') want = 'delivery_unknown';
    else if (j.status === 'queued' || j.status === 'sending' || j.status === 'retry_wait') want = 'queued';
    if (want && r.notification_status !== want) rewards_().update(r, { notification_status: want });
  });
}

/** Account match: команда позначила needs_account_match — один раз просимо уточнення (відповідь піде до команди як звернення). */
function rewardsAccountClarify_(S) {
  rewards_().rows.forEach(function (r) {
    if (r.reward_choice !== 'premium_month' || r.account_match_status !== 'needs_account_match' || r.status === 'fulfilled' || r.contact_allowed !== true) return;
    const p = participants_().get(r.participant_id);
    if (!p || !rewardCanNotify_(r, p)) return;
    enqueueOutbox_({
      idempotencyKey: 'reward_clarify:' + r.reward_id, participantId: p.participant_id, recipientChatId: p.chat_id, kind: 'reward_clarify',
      payload: { text: renderTemplate_('reward_account_clarify'), reply_markup: mainMenuKb_() }, priority: PRIORITY.REWARD_DONE, meta: { proactive: true }
    });
  });
}

function rewardsTick_(S) {
  rewardsHousekeeping_(S);
  rewardsAccountClarify_(S);
}

/**
 * Перед видаленням даних учасника: якщо подяку вже опубліковано на сайті, створюємо мінімальний службовий запит
 * на зняття публікації БЕЗ персональних даних (лише непрямий ID запису й URL) і чесно повідомляємо учаснику.
 */
function rewardsBeforeDelete_(p) {
  const r = rewardOf_(p.participant_id);
  const out = [];
  if (!r) return out;
  if (r.reward_choice === 'public_thanks' && (r.status === 'fulfilled' || r.public_thanks_url || r.public_entry_id)) {
    const entry = r.public_entry_id || r.reward_id;
    reportIncident_('rewards', 'public_takedown_requested',
      'Учасник видалив дані. Зніміть публічну подяку вручну: запис ' + entry + (r.public_thanks_url ? ', URL ' + r.public_thanks_url : '') + '. Після зняття закрийте цей інцидент.',
      { level: 'warn', entityType: 'public_entry', entityId: entry, notify: true });
    out.push('уже опублікована подяка на сайті не видаляється автоматично: команда зніме її вручну (запит створено)');
  }
  return out;
}
