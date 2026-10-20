/**
 * Worker.gs — tick_(): одноразовий короткий запуск за тригером everyMinutes(1).
 *
 * Послідовність (розділ 4.2 вимог):
 *  1 lock -> 2 конфігурація/схема -> 3 getUpdates -> 4 запис у Inbox -> 5 flush і перевірка запису ->
 *  6 збереження offset -> 7 обробка подій -> 8 зміни стану -> 9 відповіді з таблиці ->
 *  10 планові повідомлення -> 11 доставка Outbox -> 12 метрики і звільнення lock.
 *
 * Telegram НЕ підтверджується (offset не просувається), доки події не записані в Inbox і не перевірені.
 */

function inbox_() {
  const t = table_('INBOX');
  if (!t.loaded) t.load(parseInt(propGet_(PROP.WM_INBOX) || '3', 10));
  return t;
}

function propSetMany_(obj) {
  const c = G();
  const strs = {};
  Object.keys(obj).forEach(function (k) { strs[k] = String(obj[k]); c.propMap[k] = strs[k]; });
  c.props.setProperties(strs);
}

function tick_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;               // інший tick ще працює — тихо завершуємо
  resetCtx_();
  let ok = true;
  try {
    runTick_();
  } catch (e) {
    ok = false;
    handleTickError_(e);
  } finally {
    try { writeTickMetrics_(ok); } catch (e2) { /* метрики не повинні ламати lock */ }
    lock.releaseLock();
  }
}

function runTick_() {
  const c = G();
  checkConfig_();
  const setupMode = propGet_(PROP.SETUP_MODE) === 'true';
  if (!setupMode && !propGet_(PROP.OWNER_CHAT_ID)) {
    throw new SafeError('no_owner', 'OWNER_CHAT_ID не задано поза SETUP_MODE. Завершіть прив\'язку власника (setup_()).');
  }
  const S = settings_();
  if (c.settingsProblems.length) {
    reportIncident_('settings', 'settings_invalid', c.settingsProblems.join('; '), { level: 'warn' });
  }
  const budgetEnd = c.startedMs + S.TICK_WORK_BUDGET_SECONDS * 1000;
  checkHeartbeatGap_();
  propSetMany_({ LAST_TICK_AT: nowIso_() });

  fetchAndStoreUpdates_(S, setupMode);

  if (setupMode) {
    processSetupBind_();
    deliverOutbox_(budgetEnd);
    advanceOutboxWatermark_();
    return;
  }
  const evBefore = c.metrics.events;
  processInbox_(S, budgetEnd);
  if (c.metrics.events > evBefore) deliverOutbox_(budgetEnd);              // відповіді учасникам йдуть одразу, не чекаючи розкладу й таблиці відповідей
  if (nowMs_() < budgetEnd) delegate_('processTeamReplies_', S);          // етап 2: відповіді з таблиці
  if (nowMs_() < budgetEnd) runScheduler_(S);
  deliverOutbox_(budgetEnd);
  delegate_('syncSupportStatuses_', S);                                   // статуси відповідей/сповіщень — ДО просування водяних знаків
  delegate_('rewardsTick_', S);                                           // етап 3: статуси й видача подяк після релізу
  delegate_('surveyRestoreStale_', S);                                    // покинута зміна відповідей: завершена анкета знову completed
  delegate_('safeRefreshOverview_', S);                                   // етап 3: "Огляд" і воронка (не частіше за OVERVIEW_REFRESH_MINUTES)
  advanceInboxWatermark_();
  advanceOutboxWatermark_();
  if (propGet_('LAST_TICK_OK') === 'false') { recoverIncident_('worker', 'tick_failed', ''); }
  fastPollLoop_(S);
}

// ---------- Швидка відповідь (довге опитування) ----------
/**
 * Тригер Apps Script спрацьовує раз на хвилину, тому без цього режиму бот бачив нове повідомлення в середньому через ~30 с.
 * Поки в чаті є активність (FAST_POLL_IDLE_MINUTES після останнього повідомлення), запуск лишається "на зв'язку":
 * тримає довгий запит getUpdates і відповідає одразу. Добовий ліміт FAST_POLL_DAILY_MINUTES береже квоту Google.
 * Усе, що стосується надійності (запис у Inbox -> перевірка -> offset -> обробка), виконується тими самими функціями.
 */
/** Скільки секунд роботи запусків уже враховано за сьогодні й де запобіжник. Оцінка квоти тригерів Google (запуски без роботи не рахуються). */
function quotaToday_(S, nowMs) {
  const day = localDateStr_(nowMs, S.TIMEZONE);
  const rec = safeJsonParse_(propGet_(PROP.RUN_USED), null);
  const limitSec = S.TRIGGER_DAILY_LIMIT_MINUTES * 60;
  return {
    day: day, usedSec: (rec && rec.d === day) ? Number(rec.s) || 0 : 0,
    limitSec: limitSec, guardSec: limitSec * S.QUOTA_GUARD_PERCENT / 100
  };
}

/** Безперервне прослуховування, увімкнене власником (/live): до якого моменту (мс) або null. */
function liveUntilMs_() {
  const v = parseIso_(propGet_(PROP.LIVE_UNTIL));
  return v !== null && v > nowMs_() ? v : null;
}

function fastPollLoop_(S) {
  const c = G();
  const maxSec = Number(S.FAST_POLL_SECONDS) || 0;
  if (maxSec <= 0) return;
  const t0 = nowMs_();
  const live = liveUntilMs_() !== null;
  const lastAct = parseIso_(propGet_(PROP.LAST_ACTIVITY_AT));
  if (!live && (lastAct === null || t0 - lastAct > S.FAST_POLL_IDLE_MINUTES * 60000)) return;
  const q = quotaToday_(S, t0);
  const usedRec = safeJsonParse_(propGet_(PROP.FAST_USED), null);
  let usedSec = (usedRec && usedRec.d === q.day) ? Number(usedRec.s) || 0 : 0;
  const capSec = S.FAST_POLL_DAILY_MINUTES * 60;
  const fastEnd = c.startedMs + maxSec * 1000;                    // коли припиняємо чекати нові повідомлення
  const hardEnd = c.startedMs + 58000;                            // не заходимо в наступну хвилину
  const overGuard = function () { return q.usedSec + (nowMs_() - c.startedMs) / 1000 >= q.guardSec; };
  let guardStop = false;
  let loops = 0;
  while (loops < 40) {
    loops++;
    const left = fastEnd - nowMs_();
    const waitSec = Math.min(25, Math.floor(left / 1000) - 2);    // 2 с лишаємо на хвіст запиту; обробка триває до hardEnd
    if (waitSec < 2) break;
    if (overGuard()) { guardStop = true; break; }
    if (!live && usedSec + (nowMs_() - t0) / 1000 >= capSec) break;
    const n = fetchAndStoreUpdates_(S, false, waitSec);
    if (n > 0) {
      c.metrics.fast = (c.metrics.fast || 0) + n;
      const sendsBefore = c.sends;
      c.sends = 0;                                                // ліміт відправок діє на кожну порцію, а не на весь запуск
      processInbox_(S, hardEnd);
      deliverOutbox_(hardEnd);
      c.sends += sendsBefore;
      advanceInboxWatermark_();
    } else if (c.metrics.errors > 0 && nowMs_() - t0 < 1500) {
      break;                                                      // Telegram не відповів: не крутимо цикл
    }
  }
  const spent = Math.round((nowMs_() - t0) / 1000);
  if (spent > 0) propSet_(PROP.FAST_USED, JSON.stringify({ d: q.day, s: usedSec + spent }));
  if (guardStop && propGet_(PROP.QUOTA_GUARD_DAY) !== q.day) {
    propSet_(PROP.QUOTA_GUARD_DAY, q.day);
    reportIncident_('quota', 'fast_mode_paused', 'Сьогодні запуски вже працювали ~' + Math.round(q.usedSec / 60) + ' хв із ' + Math.round(q.limitSec / 60) +
      ' хв квоти Google (запобіжник ' + S.QUOTA_GUARD_PERCENT + '%). Швидкий режим і /live призупинено до завтра. Бот відповідає як звичайно, до ~1 хв.', { level: 'warn', notify: true });
  }
}

// ---------- Конфігурація ----------
function checkConfig_() {
  if (!propGet_(PROP.BOT_TOKEN)) throw new SafeError('no_token', 'Не задано BOT_TOKEN.');
  if (!propGet_(PROP.SPREADSHEET_ID)) throw new SafeError('no_spreadsheet', 'Не задано SPREADSHEET_ID.');
  const sv = parseInt(propGet_(PROP.SCHEMA_VERSION) || '0', 10);
  if (sv < SCHEMA_VERSION) migrate_();                                    // міграція лише додає схему, дані не чіпає
  if (sv > SCHEMA_VERSION) throw new SafeError('schema_newer', 'Схема таблиці новіша за код. Оновіть код проєкту.');
}

// ---------- Heartbeat ----------
function checkHeartbeatGap_() {
  const last = parseIso_(propGet_(PROP.LAST_TICK_AT));
  if (last === null) return;
  const gapMin = Math.round((nowMs_() - last) / 60000);
  if (gapMin > HEARTBEAT_GAP_MINUTES) {
    const lossPossible = gapMin > INBOX_LOSS_GAP_HOURS * 60;
    const code = lossPossible ? 'inbound_loss_possible' : 'heartbeat_gap';
    const summary = lossPossible
      ? 'Перерва в роботі ~' + Math.round(gapMin / 60) + ' год (> 24 год): Telegram міг не зберегти частину вхідних повідомлень.'
      : 'Пропущено heartbeat: перерва ~' + gapMin + ' хв. Черги збережено, роботу відновлено.';
    const inc = reportIncident_('worker', code, summary, { level: lossPossible ? 'error' : 'warn', notify: true });
    if (inc) table_('TECHLOG').update(inc, { state: 'closed', closed_at: nowIso_() });   // окремий інцидент на кожну перерву
  }
}

function handleTickError_(e) {
  const code = (e && e.code) ? e.code : 'tick_exception';
  const msg = scrub_(e && e.message);
  propSet_('LAST_TICK_OK', 'false');
  try { Logger.log('tick_failed [' + code + ']: ' + msg); } catch (x) { /* ignore */ }
  const immediate = ['no_owner', 'schema_missing', 'schema_column_missing', 'schema_newer'].indexOf(code) >= 0;
  try {
    const tbl = table_('TECHLOG');
    const last = tbl.lastDataRow();
    tbl.load(Math.max(3, last - 499)); tbl._incidentWindowLoaded = true;
    const prior = tbl.find(function (r) { return r.component === 'worker' && r.error_code === 'tick_failed' && r.state !== 'closed'; });
    const occ = prior ? (prior.occurrences || 1) : 0;
    reportIncident_('worker', 'tick_failed', 'Запуск завершився помилкою [' + code + ']: ' + trunc_(msg, 250), { level: 'error', notify: immediate || occ >= 2 });
  } catch (x2) { /* Sheets може бути причиною збою — журналу немає, лишається Logger */ }
}

function writeTickMetrics_(ok) {
  const c = G();
  const dur = nowMs_() - c.startedMs;
  const info = { at: nowIso_(), durationMs: dur, ok: ok, metrics: c.metrics, sends: c.sends, version: APP_VERSION };
  const out = { LAST_TICK_JSON: JSON.stringify(info), LAST_TICK_OK: ok ? 'true' : 'false' };
  try {                                                           // облік квоти: той самий запис у властивості, без зайвого виклику
    const q = quotaToday_(settings_(), nowMs_());
    out.RUN_USED = JSON.stringify({ d: q.day, s: Math.round(q.usedSec + dur / 1000) });
  } catch (e) { /* облік не повинен ламати запуск */ }
  propSetMany_(out);
}

// ---------- Отримання updates ----------
function existingEventIds_() {
  const t = table_('INBOX');
  const last = t.lastDataRow();
  const from = Math.max(3, last - 499);
  const set = {};
  t.readColumn('event_id', from).forEach(function (id) { if (id) set[String(id)] = true; });
  return set;
}

function verifyBindCode_(text) {
  const m = /^\/bind_owner(?:@\w+)?\s+(\S+)/i.exec(toText_(text));
  if (!m) return 'bad';
  const hash = propGet_(PROP.SETUP_BIND_HASH);
  const exp = parseIso_(propGet_(PROP.SETUP_BIND_EXPIRES));
  if (!hash || exp === null) return 'bad';
  if (nowMs_() > exp) return 'expired';
  return sha256Hex_(m[1].trim().toUpperCase()) === hash ? 'ok' : 'bad';
}

function splitString_(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function inboxRowsFor_(upd, botId, setupMode, receivedIso) {
  let bind = null;
  const rawText = upd.message && upd.message.text;
  if (setupMode && rawText && /^\/bind_owner(@\w+)?(\s|$)/i.test(rawText) && upd.message.chat && upd.message.chat.type === 'private') {
    bind = verifyBindCode_(rawText);                      // перевірка ДО редагування; сам код у таблицю не потрапляє
  }
  const n = normalizeUpdate_(upd);
  if (bind) n.payload.bind_result = bind;
  const eid = botId + ':' + upd.update_id;
  const json = JSON.stringify(n.payload);
  const parts = json.length > INBOX_PAYLOAD_PART ? splitString_(json, INBOX_PAYLOAD_PART) : [json];
  const checksum = sha256Hex_(json);
  let business = null;
  if (n.payload.kind === 'message') business = n.chatId + ':' + n.payload.message.message_id + ':new';
  else if (n.payload.kind === 'edited_message') business = n.chatId + ':' + n.payload.message.message_id + ':edit' + (n.payload.message.edit_date || upd.update_id);
  return parts.map(function (part, i) {
    return {
      event_id: i === 0 ? eid : eid + '#p' + (i + 1), bot_id: botId, update_id: String(upd.update_id),
      event_type: i === 0 ? n.eventType : 'payload_part', telegram_user_id: n.userId || null, chat_id: n.chatId || null,
      received_at: receivedIso, payload_json: part, payload_parts_count: parts.length, payload_checksum: checksum,
      status: i === 0 ? 'pending' : 'part', attempt_count: 0, next_attempt_at: null, processed_at: null,
      error_code: null, error_note: null, business_key: i === 0 ? business : null
    };
  });
}

/** Повертає кількість нових записаних подій. timeoutSec — довге опитування (Telegram тримає запит, доки не з'явиться повідомлення). */
function fetchAndStoreUpdates_(S, setupMode, timeoutSec) {
  const c = G();
  const botId = propGet_(PROP.BOT_ID) || 'bot';
  const offRaw = propGet_(PROP.TELEGRAM_NEXT_OFFSET);
  const res = tgGetUpdates_(offRaw === null ? null : Number(offRaw), S.MAX_UPDATES_PER_BATCH, timeoutSec);
  if (!res.ok) {
    if (res.kind === 'conflict') reportIncident_('telegram', 'conflict', 'Telegram повертає 409: активний webhook або інший getUpdates. Polling і webhook не можуть працювати паралельно.', { level: 'critical', notify: true });
    else if (res.kind === 'unauthorized') reportIncident_('telegram', 'unauthorized', 'Telegram повертає 401: BOT_TOKEN недійсний.', { level: 'critical', notify: true });
    else c.metrics.errors++;
    return 0;
  }
  const updates = res.result || [];
  if (!updates.length) return 0;
  c.metrics.updates += updates.length;
  const seen = existingEventIds_();
  const nowIso = nowIso_();
  const rows = [];
  let maxId = -1;
  updates.forEach(function (u) {
    if (typeof u.update_id !== 'number') return;
    if (u.update_id > maxId) maxId = u.update_id;
    if (seen[botId + ':' + u.update_id]) return;          // повторний update не створює другої події
    seen[botId + ':' + u.update_id] = true;                // дублікат у межах однієї порції теж ігнорується
    inboxRowsFor_(u, botId, setupMode, nowIso).forEach(function (r) { rows.push(r); });
  });
  const tbl = inbox_();
  if (rows.length) {
    tbl.appendMany(rows);
    SpreadsheetApp.flush();
    // перевірка запису перед підтвердженням: усі нові event_id мають бути в таблиці
    const check = {};
    tbl.readColumn('event_id', Math.max(3, tbl.lastDataRow() - rows.length - 5)).forEach(function (id) { if (id) check[String(id)] = true; });
    rows.forEach(function (r) { if (!check[r.event_id]) throw new SafeError('inbox_verify_failed', 'Не вдалося підтвердити запис події в Inbox; offset не просунуто.'); });
  }
  if (maxId >= 0) propSet_(PROP.TELEGRAM_NEXT_OFFSET, maxId + 1);       // лише після стійкого збереження
  if (rows.length) propSet_(PROP.LAST_ACTIVITY_AT, nowIso_());
  if (rows.length && !setupMode && typeof ackSend_ === 'function') ackSend_(S, updates, botId);   // «Обробляю…» — вже після стійкого збереження
  return rows.length;
}

// ---------- Обробка Inbox ----------
function inboxPayload_(ev) {
  const t = inbox_();
  let json = ev.payload_json || '';
  const n = ev.payload_parts_count || 1;
  if (n > 1) {
    for (let i = 2; i <= n; i++) {
      const part = t.get(ev.event_id + '#p' + i);
      if (!part) throw new SafeError('payload_part_missing', 'Не знайдено частину payload ' + i + '/' + n);
      json += part.payload_json;
    }
    if (sha256Hex_(json) !== ev.payload_checksum) throw new SafeError('payload_checksum', 'Контрольна сума payload не збіглася.');
  }
  const pl = safeJsonParse_(json, null);
  if (!pl) throw new SafeError('payload_unparsable', 'Payload події не розібрано.');
  return pl;
}

function processInbox_(S, budgetEnd) {
  const c = G();
  const tbl = inbox_();
  const seenBusiness = {};
  tbl.rows.forEach(function (r) { if (r.business_key && (r.status === 'processed' || r.status === 'duplicate')) seenBusiness[r.business_key] = true; });
  const blockedUsers = {};
  const deletedUsers = {};
  const events = tbl.rows.filter(function (r) { return r.status === 'pending' || r.status === 'held'; }).sort(function (a, b) { return a._row - b._row; });
  for (let i = 0; i < events.length; i++) {
    if (nowMs_() >= budgetEnd) break;
    const ev = events[i];
    const uid = ev.telegram_user_id || '';
    if (uid && (deletedUsers[uid] || blockedUsers[uid])) continue;
    const due = parseIso_(ev.next_attempt_at);
    if (due !== null && due > nowMs_()) { if (uid) blockedUsers[uid] = true; continue; }
    if (ev.chat_id && !inboundAllowed_(ev.chat_id, S)) {
      if (ev.status === 'pending') tbl.update(ev, { status: 'held', error_note: 'Очікує: TEST_MODE або DELIVERY_ENABLED=false (чат не в allowlist).' });
      continue;
    }
    if (ev.business_key && seenBusiness[ev.business_key] && ev.status !== 'held') {
      tbl.update(ev, { status: 'duplicate', processed_at: nowIso_() });
      continue;
    }
    try {
      const pl = inboxPayload_(ev);
      const res = handleInboxEvent_(ev, pl);
      c.metrics.events++;
      if (res.deleted) { if (uid) deletedUsers[uid] = true; continue; }     // рядки події вже видалено разом із даними
      if (ev.business_key) seenBusiness[ev.business_key] = true;
      tbl.update(ev, { status: res.status === 'ignored' ? 'ignored' : 'processed', processed_at: nowIso_(), error_code: null, error_note: res.note || null });
    } catch (e) {
      c.metrics.errors++;
      const attempts = (ev.attempt_count || 0) + 1;
      const code = (e && e.code) ? e.code : 'event_exception';
      const note = trunc_(scrub_(e && e.message), 250);
      if (attempts >= S.MAX_RETRY_ATTEMPTS) {
        tbl.update(ev, { status: 'manual_review', attempt_count: attempts, error_code: code, error_note: note });
        reportIncident_('inbox', 'event_manual_review', 'Подію не вдалося обробити після ' + attempts + ' спроб (' + code + '). Повідомлення збережено в "Вхідні" зі статусом manual_review.', { level: 'error', entityType: 'inbox_event', entityId: ev.event_id, notify: true });
      } else {
        tbl.update(ev, { attempt_count: attempts, error_code: code, error_note: note, next_attempt_at: isoSec_(nextAttemptMs_(attempts, null, nowMs_())) });
      }
      if (uid) blockedUsers[uid] = true;           // зберігаємо порядок подій одного чату
    }
  }
  if (events.length && typeof ackProgress_ === 'function') ackProgress_(S);        // «Майже готово» перед відправкою відповіді
}

function advanceInboxWatermark_() {
  const tbl = inbox_();
  let wm = null;
  for (let i = 0; i < tbl.rows.length; i++) {
    const s = tbl.rows[i].status;
    if (s === 'pending' || s === 'held') { wm = tbl.rows[i]._row; break; }
  }
  if (wm === null) wm = Math.max(tbl.lastDataRow() + 1, 3);
  if (String(wm) !== String(propGet_(PROP.WM_INBOX) || '3')) propSet_(PROP.WM_INBOX, wm);
}

// ---------- Прив'язка власника (SETUP_MODE) ----------
function processSetupBind_() {
  const tbl = inbox_();
  const events = tbl.rows.filter(function (r) { return r.status === 'pending'; }).sort(function (a, b) { return a._row - b._row; });
  events.forEach(function (ev) {
    let pl;
    try { pl = safeJsonParse_(ev.payload_json, null); } catch (e) { pl = null; }
    if (!pl || !pl.bind_result) return;                       // звичайні повідомлення чекають завершення setup
    if (pl.bind_result !== 'ok') { tbl.update(ev, { status: 'ignored', processed_at: nowIso_(), error_note: 'bind_' + pl.bind_result }); return; }
    if (propGet_(PROP.OWNER_CHAT_ID)) { tbl.update(ev, { status: 'ignored', processed_at: nowIso_(), error_note: 'owner_already_bound' }); return; }
    propSetMany_({ OWNER_TELEGRAM_USER_ID: idText_(pl.from && pl.from.id), OWNER_CHAT_ID: idText_(pl.chat && pl.chat.id) });
    propDelete_(PROP.SETUP_BIND_HASH);                         // код стає недійсним
    propDelete_(PROP.SETUP_BIND_EXPIRES);
    enqueueOutbox_({
      idempotencyKey: 'owner_bind_confirm', participantId: null, recipientChatId: idText_(pl.chat.id), kind: 'owner_bind_confirm',
      payload: { text: renderTemplate_('owner_bind_ok') }, priority: PRIORITY.OWNER_ALERT
    });
    tbl.update(ev, { status: 'processed', processed_at: nowIso_(), error_note: 'owner_bound' });
  });
}

/** Після доставленого підтвердження прив'язки SETUP_MODE завершується; TEST_MODE лишається увімкненим. */
function onOwnerBindSent_(job) {
  propDelete_(PROP.SETUP_MODE);
}
