/**
 * Analytics.gs — лист "Огляд" (воронка й показники), колонки "Етап воронки"/"Що далі" в "Учасники",
 * команда власника /stats.
 *
 * Принципи (розділи 9–10 вимог):
 *  - тестові записи (is_test_record) і власник у метрики не входять;
 *  - вимірюване й самозвіт не змішуються: G1/G2/U5 — це самозвіт; Outbox — доставка повідомлення, а не встановлення;
 *  - порожнє значення магазину = невідомо (null), а не 0; зрізи з перекривними періодами не сумуються;
 *  - "Install Clicks" ніколи не подається як acquisition;
 *  - жодного "рейтингу цінності" з позитивних слів.
 */

const FUNNEL_STEPS = [
  { key: 'started', label: 'Запустили бота', short: 'Запустив бота (без згоди)', test: function () { return true; } },
  { key: 'consent', label: 'Дали згоду (16+)', short: 'Дав згоду, обирає платформу/роль', test: function (p) { return !!p.consent_at; } },
  { key: 'profile', label: 'Вказали платформу й роль', short: 'Вказав платформу й роль, чекає посилання', test: function (p) { return !!p.declared_role; } },
  { key: 'link', label: 'Отримали посилання (тест розпочато)', short: 'Тестує (посилання отримано)', test: function (p) { return !!p.trial_started_at; } },
  { key: 'invited', label: 'Отримали запрошення в анкету', short: 'Запрошений в анкету', test: function (p) { return !!p.survey_invite_sent_at; } },
  { key: 'survey_started', label: 'Почали анкету', short: 'Анкета розпочата', test: function (p, x) { return !!(x.survey && x.survey.started_at); } },
  { key: 'survey_done', label: 'Завершили анкету', short: 'Анкету завершено', test: function (p, x) { return !!(x.survey && x.survey.status === 'completed'); } },
  { key: 'reward_chosen', label: 'Обрали подяку', short: 'Обрав подяку', test: function (p, x) { return !!(x.reward && x.reward.reward_choice && x.reward.status !== 'cancelled_by_user'); } },
  { key: 'reward_done', label: 'Подяку виконано', short: 'Подяку виконано', test: function (p, x) { return !!(x.reward && x.reward.status === 'fulfilled'); } }
];

function pct_(n, d) { return d > 0 ? (Math.round(n * 1000 / d) / 10) + '%' : '—'; }
function sheetSafe_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? ' ' + v : v;
}

function isRealParticipant_(p) { return p.is_test_record !== true; }

function indexBy_(rows, keyFn) {
  const m = {};
  rows.forEach(function (r) { const k = keyFn(r); if (k) m[k] = r; });
  return m;
}

/** Поточний стан учасника у воронці: найвищий досягнутий крок + пояснення "що далі". */
function funnelStageOf_(p, x, S, now) {
  const tz = S.TIMEZONE;
  const prefix = p.is_test_record === true ? '(тест) ' : '';
  if (p.participation_status === 'waiting_capacity') return { stage: prefix + '0. Очікує місця (черга)', note: 'Чекає, поки з\'явиться місце.', idx: -1 };
  if (p.declined_at && !p.consent_at) return { stage: prefix + '— Відмовився приєднатися', note: 'Не приєднався.', idx: -2 };
  let h = 0;
  for (let i = FUNNEL_STEPS.length - 1; i >= 0; i--) { if (FUNNEL_STEPS[i].test(p, x)) { h = i; break; } }
  const stage = prefix + (h + 1) + '. ' + FUNNEL_STEPS[h].short;
  const flags = [];
  if (p.contact_status === 'blocked') flags.push('заблокував бота');
  if (p.contact_status === 'opted_out') flags.push('вимкнув повідомлення');
  if (p.participation_status === 'withdrawn' && p.consent_at) flags.push('вийшов з участі');
  if (x.survey && x.survey.status === 'collection_closed') flags.push('автозбір завершено без анкети');
  if (p.feedback_received === true) flags.push('є фідбек');
  let next = '';
  const fmt = function (iso) { const ms = parseIso_(iso); return ms === null ? '—' : localDateDots_(ms, tz); };
  switch (h) {
    case 0: next = 'Очікується згода.'; break;
    case 1: next = 'Очікується вибір платформи й ролі.'; break;
    case 2: next = 'Очікується доставка посилання.'; break;
    case 3: next = 'Тест до ' + fmt(p.trial_end_at) + (p.extension_used === true ? ' (продовжено)' : '') + '; запрошення в анкету — після цієї дати.'; break;
    case 4: next = 'Запрошено ' + fmt(p.survey_invite_sent_at) + '; автозбір до ' + fmt(p.feedback_collection_deadline) + '; нагадувань: ' + (p.survey_reminders_sent || 0) + '.'; break;
    case 5: next = 'Питання ' + ((x.survey && x.survey.current_question_id) || '—') + (x.survey && x.survey.status === 'paused' ? ' (пауза)' : '') + '.'; break;
    case 6: next = 'Анкету завершено ' + fmt(x.survey && x.survey.completed_at) + '.'; break;
    case 7: next = 'Очікується видача: ' + rewardChoiceLabel_(x.reward.reward_choice) + (S.RELEASE_CONFIRMED ? '.' : ' (після підтвердженого релізу).'); break;
    case 8: next = 'Готово.'; break;
  }
  if (h >= 6 && (!x.reward || !x.reward.reward_choice)) next += ' Подяку ще не обрано.';
  return { stage: stage, note: trunc_(next + (flags.length ? ' [' + flags.join(', ') + ']' : ''), 250), idx: h };
}

function rewardChoiceLabel_(c) {
  return ({ premium_month: 'місяць преміуму', research_results: 'результати тестування', public_thanks: 'публічна подяка' })[c] || '—';
}

/** Один прохід: збирає всі показники. Використовується для "Огляду" та /stats. */
function collectMetrics_(S, now) {
  const all = participants_().rows;
  const real = all.filter(isRealParticipant_);
  const realIds = {};
  real.forEach(function (p) { realIds[p.participant_id] = true; });

  const surveyBy = {};
  surveys_().rows.forEach(function (s) {
    const cur = surveyBy[s.participant_id];
    if (!cur || (parseIso_(s.started_at) || 0) >= (parseIso_(cur.started_at) || 0)) surveyBy[s.participant_id] = s;
  });
  const rewardBy = {};
  rewards_().rows.forEach(function (r) { rewardBy[r.participant_id] = r; });

  const m = { now: now, S: S, realCount: real.length, testCount: all.length - real.length, funnel: [], stages: {} };

  // ---- воронка ----
  const high = {};
  real.forEach(function (p) {
    const x = { survey: surveyBy[p.participant_id] || null, reward: rewardBy[p.participant_id] || null };
    const st = funnelStageOf_(p, x, S, now);
    high[p.participant_id] = st.idx;
  });
  FUNNEL_STEPS.forEach(function (step, i) {
    const row = { key: step.key, label: step.label, all: 0, android: 0, ios: 0, both: 0, here: 0, dropped: 0 };
    real.forEach(function (p) {
      const x = { survey: surveyBy[p.participant_id] || null, reward: rewardBy[p.participant_id] || null };
      if (step.test(p, x)) {
        row.all++;
        if (p.platform === 'android') row.android++; else if (p.platform === 'ios') row.ios++; else if (p.platform === 'both') row.both++;
      }
      if (high[p.participant_id] === i) {
        const sv = x.survey;
        const dropped = p.contact_status === 'blocked' || p.participation_status === 'withdrawn' ||
          (sv && sv.status === 'collection_closed') || (p.participation_status === 'finished' && !(sv && sv.status === 'completed') && i < 6);
        if (dropped) row.dropped++; else row.here++;
      }
    });
    m.funnel.push(row);
  });
  m.waiting = real.filter(function (p) { return p.participation_status === 'waiting_capacity'; }).length;
  m.declined = real.filter(function (p) { return p.declined_at && !p.consent_at; }).length;

  // ---- статуси участі й доступність ----
  m.byStatus = {};
  real.forEach(function (p) { m.byStatus[p.participation_status] = (m.byStatus[p.participation_status] || 0) + 1; });
  m.blocked = real.filter(function (p) { return p.contact_status === 'blocked'; }).length;
  m.optedOut = real.filter(function (p) { return p.contact_status === 'opted_out'; }).length;

  // ---- посилання за платформою (доставка повідомлення; не прочитання й не встановлення) ----
  m.linkByPlatform = { android: 0, ios: 0, both: 0, total: 0 };
  real.forEach(function (p) {
    if (!p.trial_started_at) return;
    m.linkByPlatform.total++;
    if (m.linkByPlatform[p.platform] !== undefined) m.linkByPlatform[p.platform]++;
  });

  // ---- фідбек й анкети ----
  m.feedback = real.filter(function (p) { return p.feedback_received === true; }).length;
  const realSurveys = Object.keys(surveyBy).filter(function (pid) { return realIds[pid]; }).map(function (pid) { return surveyBy[pid]; });
  const answers = answers_().rows.filter(function (a) { return realIds[a.participant_id]; });
  const realAnswered = {};
  answers.forEach(function (a) { if (a.is_current === true && a.answer_format !== 'skipped') realAnswered[a.survey_id] = true; });
  m.surveys = { completed: 0, partial: 0, closed: 0 };
  realSurveys.forEach(function (s) {
    if (s.status === 'completed') m.surveys.completed++;
    else if (realAnswered[s.survey_id] || ((s.status === 'in_progress' || s.status === 'paused') && s.started_at)) m.surveys.partial++;
    else if (s.status === 'collection_closed') m.surveys.closed++;
  });
  m.feedbackDenominator = m.linkByPlatform.total;

  // ---- самозвіт G1, G2, U5 ----
  const cur = answers.filter(function (a) { return a.is_current === true && a.applies_to_current_branch !== false; });
  function dist(qid) {
    const d = { answered: 0, skipped: 0, codes: {} };
    cur.filter(function (a) { return a.question_id === qid; }).forEach(function (a) {
      if (a.answer_format === 'skipped') { d.skipped++; return; }
      d.answered++;
      const j = safeJsonParse_(a.answer_enum_or_json, {}) || {};
      const codes = j.codes || (j.code ? [j.code] : []);
      codes.forEach(function (c) { d.codes[c] = (d.codes[c] || 0) + 1; });
    });
    return d;
  }
  m.g1 = dist('G1'); m.g2 = dist('G2'); m.u5 = dist('U5');
  m.roles = { author: 0, viewer: 0, both: 0 };
  real.forEach(function (p) { if (m.roles[p.declared_role] !== undefined) m.roles[p.declared_role]++; });

  // ---- звернення ----
  const tickets = tickets_().rows.filter(function (t) { return realIds[t.participant_id]; });
  const open = tickets.filter(function (t) { return TICKET_OPEN.indexOf(t.status) >= 0; });
  m.tickets = {
    total: tickets.length, open: open.length,
    openCritical: open.filter(function (t) { return t.critical_by_user === true; }).length,
    openRegular: open.filter(function (t) { return t.critical_by_user !== true; }).length,
    noFirstReply: open.filter(function (t) { return !t.first_team_reply_at; }).length,
    overdue: open.filter(function (t) { return t.sla_overdue === true; }).length,
    alertProblem: tickets.filter(function (t) { return t.critical_by_user === true && (t.critical_alert_status === 'failed' || t.critical_alert_status === 'delivery_unknown'); }).length
  };

  // ---- винагороди ----
  const rws = rewards_().rows.filter(function (r) { return realIds[r.participant_id]; });
  m.rewards = { total: rws.length, byChoice: {}, byStatus: {}, needsAccountMatch: 0, publicReady: 0, notifyProblem: 0 };
  rws.forEach(function (r) {
    m.rewards.byStatus[r.status || '—'] = (m.rewards.byStatus[r.status || '—'] || 0) + 1;
    if (r.reward_choice && r.status !== 'cancelled_by_user') m.rewards.byChoice[r.reward_choice] = (m.rewards.byChoice[r.reward_choice] || 0) + 1;
    if (r.reward_choice === 'premium_month' && r.account_match_status === 'needs_account_match') m.rewards.needsAccountMatch++;
    if (r.reward_choice === 'public_thanks' && r.publication_consent_at && r.public_display_name && r.status !== 'fulfilled' && r.status !== 'cancelled_by_user') m.rewards.publicReady++;
    if (r.notification_status === 'failed' || r.notification_status === 'delivery_unknown') m.rewards.notifyProblem++;
  });

  // ---- потребує уваги ----
  const h24 = 24 * 3600000;
  m.attention = {
    noConsent24h: real.filter(function (p) { return !p.consent_at && !p.declined_at && p.participation_status !== 'waiting_capacity' && now - (parseIso_(p.created_at) || now) > h24; }).length,
    noLink24h: real.filter(function (p) { return p.consent_at && !p.trial_started_at && p.participation_status === 'onboarding' && now - (parseIso_(p.consent_at) || now) > h24; }).length,
    invitedNotStarted: real.filter(function (p) { const s = surveyBy[p.participant_id]; return p.survey_invite_sent_at && !(s && (s.started_at || s.status === 'completed')) && p.participation_status === 'awaiting_feedback'; }).length,
    partialStale: realSurveys.filter(function (s) { return (s.status === 'in_progress' || s.status === 'paused') && now - (parseIso_(s.last_answer_at) || parseIso_(s.started_at) || now) > 2 * 86400000; }).length
  };

  // ---- система ----
  const ob = {};
  outbox_().rows.forEach(function (j) { ob[j.status] = (ob[j.status] || 0) + 1; });
  m.outbox = ob;
  const ib = {};
  inbox_().rows.forEach(function (e) { if (e.status !== 'part') ib[e.status] = (ib[e.status] || 0) + 1; });
  m.inbox = ib;
  const tl = table_('TECHLOG');
  tl.load(Math.max(3, tl.lastDataRow() - 499));
  m.incidents = tl.rows.filter(function (r) { return r.state === 'open'; });
  const last = parseIso_(propGet_(PROP.LAST_TICK_AT));
  m.lastTickMin = last === null ? null : Math.round((now - last) / 60000);
  m.lastTickOk = propGet_('LAST_TICK_OK') !== 'false';
  return m;
}

// ---------- Показники магазинів ----------
function storeMetricKind_(row) {
  const name = toText_(row.metric_name);
  if (/install\s*clicks?/i.test(name)) return { code: 'intent', note: 'Намір установити (кліки Install). НЕ є acquisition і НЕ є встановленням.' };
  if (row.platform === 'android' && /acquisition/i.test(name)) return { code: 'android_acq', note: 'Агрегована метрика Google Play за визначенням звіту; одиниці Google.' };
  if (row.platform === 'ios' && /first[-\s]?time\s*downloads?/i.test(name)) return { code: 'ios_ftd', note: 'Агрегована метрика App Store Connect; можливі пороги приватності.' };
  return { code: 'other', note: 'Метрика зі звіту магазину; значення дивіться в джерелі.' };
}
function parseMetricValue_(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

/** Актуальний зріз на кожну комбінацію (платформа, метрика, кампанія, період). Зрізи НЕ сумуються. */
function latestStoreSnapshots_() {
  const rows = table_('STORE_METRICS').load(3).rows;
  const groups = {};
  rows.forEach(function (r) {
    if (!r.platform && !r.metric_name) return;
    const k = [r.platform, toText_(r.metric_name).toLowerCase(), r.campaign_code, r.period_from, r.period_to].join('|');
    const cur = groups[k];
    const ra = toText_(r.retrieved_at), ca = cur ? toText_(cur.retrieved_at) : '';
    if (!cur || ra > ca || (ra === ca && r._row > cur._row)) groups[k] = r;
  });
  const list = Object.keys(groups).map(function (k) { return groups[k]; });
  // перекривні періоди однієї метрики — позначаємо, не сумуємо
  const overlaps = {};
  list.forEach(function (a) {
    list.forEach(function (b) {
      if (a === b || a.platform !== b.platform || toText_(a.metric_name).toLowerCase() !== toText_(b.metric_name).toLowerCase() || a.campaign_code !== b.campaign_code) return;
      if (a.period_from && a.period_to && b.period_from && b.period_to && a.period_from <= b.period_to && b.period_from <= a.period_to) { overlaps[a.snapshot_id || a._row] = true; }
    });
  });
  return list.sort(function (a, b) { return String(a.platform).localeCompare(String(b.platform)) || String(a.metric_name).localeCompare(String(b.metric_name)) || String(a.period_from).localeCompare(String(b.period_from)); })
    .map(function (r) { return { row: r, overlap: !!overlaps[r.snapshot_id || r._row] }; });
}

// ---------- Побудова листа "Огляд" ----------
function buildOverviewRows_(m, S, now) {
  const rows = [];
  const styles = [];
  function add(style, arr) { rows.push(arr); styles.push(style); }
  const W = 9;
  const tz = S.TIMEZONE;

  add('title', ['Огляд Mimeon alpha']);
  const stamp = ['Оновлено (Київ): ' + localDateTimeStr_(now, tz), 'версія коду ' + APP_VERSION, 'Режими: TEST_MODE=' + S.TEST_MODE + ', DELIVERY_ENABLED=' + S.DELIVERY_ENABLED];
  add('note', stamp);
  add('note', ['Тестові записи (' + m.testCount + ') і власник у показники не входять. Значення "—" означає "немає даних"; порожнє не рахується нулем.']);
  if (typeof quotaLine_ === 'function') add('note', [quotaLine_(S)]);
  add('gap', []);

  // 1. Потребує уваги
  add('h', ['1. ПОТРЕБУЄ УВАГИ ЗАРАЗ']);
  const att = [];
  if (m.tickets.openCritical) att.push(['КРИТИЧНІ звернення відкриті', m.tickets.openCritical, 'Аркуш "Звернення", фільтр critical_by_user=true.']);
  if (m.tickets.alertProblem) att.push(['Критичні звернення без підтвердженого сповіщення власнику', m.tickets.alertProblem, 'Статус critical_alert_status = failed/delivery_unknown.']);
  if (m.tickets.overdue) att.push(['Звернення без відповіді понад ' + S.SUPPORT_FIRST_RESPONSE_HOURS + ' год', m.tickets.overdue, 'Позначка sla_overdue (орієнтир, не гарантія).']);
  if (m.outbox.delivery_unknown) att.push(['Вихідні в статусі delivery_unknown', m.outbox.delivery_unknown, 'Перевірте чат і виберіть operator_action у "Вихідні".']);
  if (m.outbox.failed) att.push(['Вихідні, які не вдалося доставити (failed)', m.outbox.failed, 'Див. last_error_note у "Вихідні".']);
  if (m.inbox.manual_review) att.push(['Вхідні події на ручній перевірці', m.inbox.manual_review, 'Аркуш "Вхідні", статус manual_review.']);
  if (m.incidents.length) att.push(['Відкриті технічні інциденти', m.incidents.length, 'Аркуш "Техжурнал".']);
  if (m.rewards.needsAccountMatch) att.push(['Преміум: акаунт не знайдено (needs_account_match)', m.rewards.needsAccountMatch, 'Аркуш "Винагороди".']);
  if (m.rewards.notifyProblem) att.push(['Повідомлення про виконання подяки не доставлено', m.rewards.notifyProblem, 'Аркуш "Винагороди", notification_status.']);
  if (m.attention.noConsent24h) att.push(['Запустили бота, але не дали згоду понад 24 год', m.attention.noConsent24h, 'Аркуш "Учасники", фільтр "Етап воронки" = 1.']);
  if (m.attention.noLink24h) att.push(['Дали згоду, але не отримали посилання понад 24 год', m.attention.noLink24h, 'Фільтр "Етап воронки" = 2/3; перевірте "Вихідні".']);
  if (m.attention.invitedNotStarted) att.push(['Запрошені в анкету, ще не почали', m.attention.invitedNotStarted, 'Нагадування йдуть автоматично (максимум ' + S.MAX_SURVEY_REMINDERS + ').']);
  if (m.attention.partialStale) att.push(['Анкета розпочата, але без руху понад 2 дні', m.attention.partialStale, 'Учасник може повернутися кнопкою "Дати фідбек".']);
  if (!m.lastTickOk) att.push(['Останній запуск tick завершився помилкою', 1, 'Див. "Техжурнал".']);
  if (m.lastTickMin !== null && m.lastTickMin > HEARTBEAT_GAP_MINUTES) att.push(['Бот давно не запускався (хв тому)', m.lastTickMin, 'Перевірте тригер tick_ (рівно один).']);
  if (!att.length) add('n', ['Нічого термінового.']);
  att.forEach(function (a) { add('n', a); });
  add('gap', []);

  // 2. Воронка
  add('h', ['2. ВОРОНКА УЧАСНИКІВ (унікальні учасники; платформа відома лише з кроку 3)']);
  add('th', ['Крок', 'Усього', '% від попереднього кроку', '% від усіх запущених', 'Android', 'iPhone/iPad', 'Обидва', 'Зараз на цьому кроці', 'Вибули на цьому кроці']);
  const first = m.funnel[0].all;
  m.funnel.forEach(function (f, i) {
    const prev = i === 0 ? null : m.funnel[i - 1].all;
    add('n', [(i + 1) + '. ' + f.label, f.all, i === 0 ? '—' : pct_(f.all, prev), pct_(f.all, first), f.android, f.ios, f.both, f.here, f.dropped]);
  });
  add('n', ['Фідбек отримано (поза послідовністю: будь-яка відповідь анкети чи звернення)', m.feedback, '—', pct_(m.feedback, first), '', '', '', '', '']);
  add('note', ['Чекають місця: ' + m.waiting + '. Відмовилися приєднатися: ' + m.declined + '. "Вибули" = вийшли, заблокували бота, автозбір завершився без анкети. Для списку людей: аркуш "Учасники", фільтр за колонкою "Етап воронки".']);
  add('gap', []);

  // 3. Реєстрації й статуси
  add('h', ['3. РЕЄСТРАЦІЇ Й СТАН УЧАСТІ']);
  add('n', ['Усього учасників (без тестових)', m.realCount]);
  ['onboarding', 'waiting_capacity', 'active', 'awaiting_feedback', 'finished', 'withdrawn'].forEach(function (k) { add('n', ['  ' + k, m.byStatus[k] || 0]); });
  add('n', ['Заблокували бота (дані збережено)', m.blocked]);
  add('n', ['Вимкнули повідомлення (opted_out)', m.optedOut]);
  add('gap', []);

  // 4. Посилання й фідбек
  add('h', ['4. ПОСИЛАННЯ Й ФІДБЕК']);
  add('th', ['Показник', 'Значення', 'Знаменник / пояснення']);
  add('n', ['Посилання доставлено — усього', m.linkByPlatform.total, 'Доставка повідомлення; не прочитання й не встановлення.']);
  add('n', ['  Android', m.linkByPlatform.android]);
  add('n', ['  iPhone/iPad', m.linkByPlatform.ios]);
  add('n', ['  Обидва', m.linkByPlatform.both]);
  add('n', ['Частка фідбеку', pct_(m.feedback, m.feedbackDenominator), m.feedback + ' з ' + m.feedbackDenominator + ' (унікальні учасники з фідбеком / учасники з доставленим посиланням; увесь час)']);
  add('n', ['Анкети: завершені', m.surveys.completed]);
  add('n', ['Анкети: частково заповнені', m.surveys.partial]);
  add('n', ['Автозбір завершено без жодної відповіді анкети', m.surveys.closed]);
  add('gap', []);

  // 5. Самозвіт
  add('h', ['5. САМОЗВІТ З АНКЕТИ (не події додатка; дивіться відкриті відповіді в "Відповіді анкети" з фільтром за question_id)']);
  add('th', ['Питання', 'Відповідь', 'Кількість', 'Пояснення']);
  const g1 = [['new_install', 'Встановив/ла під час тесту'], ['existing_install', 'Вже був встановлений до запрошення'], ['not_installed', 'Не встановлював/ла'], ['unknown', 'Не пам\'ятаю']];
  g1.forEach(function (x) { add('n', ['G1 Встановлення', x[1], m.g1.codes[x[0]] || 0, x[0] === 'new_install' ? 'Самозвіт про нове встановлення в період тесту; існуюче в нові не додається.' : '']); });
  add('n', ['G1', 'Пропущено', m.g1.skipped, 'Пропуск ≠ "не пам\'ятаю" ≠ мовчання.']);
  const g2 = [['days_0', 'Жодного дня'], ['days_1', 'В один день'], ['days_2_3', 'У 2–3 дні'], ['days_4_7', 'У 4–7 днів'], ['days_8_plus', 'У 8 або більше днів'], ['unknown', 'Не пам\'ятаю']];
  g2.forEach(function (x) { add('n', ['G2 Різні дні відкриття', x[1], m.g2.codes[x[0]] || 0, 'Це інтервал, не точне число й не автоматична D1/D7 retention.']); });
  add('n', ['G2', 'Пропущено', m.g2.skipped, '']);
  add('n', ['Заявлена роль (реєстрація)', 'Автор / Глядач / Обидва', m.roles.author + ' / ' + m.roles.viewer + ' / ' + m.roles.both, 'Це задекларована роль, а не факт дії.']);
  const u5 = [['view_feed', 'Переглядав/ла стрічку'], ['open_image', 'Відкривав/ла зображення'], ['publish', 'Публікував/ла своє зображення'], ['react', 'Ставив/ла реакцію'], ['comment', 'Залишав/ла коментар'], ['save_favorite', 'Зберігав/ла в обране'], ['return_saved', 'Повертався/лась до збереженого'], ['share_link', 'Ділився/лась посиланням'], ['nothing', 'Нічого з переліченого'], ['other', 'Інше'], ['unknown', 'Не пам\'ятаю']];
  u5.forEach(function (x) { add('n', ['U5 Фактичні дії', x[1], m.u5.codes[x[0]] || 0, 'З ' + m.u5.answered + ' учасників, які відповіли на U5 (мультивибір: суми перевищують 100%).']); });
  add('gap', []);

  // 6. Звернення
  add('h', ['6. ЗВЕРНЕННЯ']);
  add('n', ['Відкриті звичайні', m.tickets.openRegular]);
  add('n', ['Відкриті КРИТИЧНІ (за вибором учасника)', m.tickets.openCritical]);
  add('n', ['Відкриті без першої відповіді команди', m.tickets.noFirstReply]);
  add('n', ['Понад ' + S.SUPPORT_FIRST_RESPONSE_HOURS + ' год без відповіді (позначка sla_overdue)', m.tickets.overdue]);
  add('n', ['Усього звернень', m.tickets.total]);
  add('gap', []);

  // 7. Винагороди
  add('h', ['7. ПОДЯКИ']);
  add('n', ['Мають право (є запис)', m.rewards.total, 'Право — за сам факт фідбеку; позитивність і кількість днів не потрібні.']);
  ['premium_month', 'research_results', 'public_thanks'].forEach(function (c) { add('n', ['  Обрали: ' + rewardChoiceLabel_(c), m.rewards.byChoice[c] || 0]); });
  ['eligible_unselected', 'pending_release', 'pending_fulfillment', 'fulfilled', 'cancelled_by_user'].forEach(function (k) { add('n', ['  Статус ' + k, m.rewards.byStatus[k] || 0]); });
  add('n', ['Публічна подяка: є згода й ім\'я, готова до публікації командою', m.rewards.publicReady, 'Публікація — окрема ручна дія; без згоди запис сюди не потрапляє.']);
  add('n', ['Преміум: needs_account_match', m.rewards.needsAccountMatch]);
  add('n', ['EXPECTED_RELEASE_MONTH (лише очікування)', S.EXPECTED_RELEASE_MONTH]);
  add('n', ['RELEASE_CONFIRMED (фактичний реліз підтверджено командою)', S.RELEASE_CONFIRMED ? 'так' : 'ні', 'Настання місяця релізу цей параметр сам не змінює.']);
  add('n', ['REPORT_READY / версія звіту', (S.REPORT_READY ? 'так' : 'ні') + ' / ' + S.REPORT_VERSION]);
  add('gap', []);

  // 8. Магазини
  add('h', ['8. ПОКАЗНИКИ МАГАЗИНІВ (вносить команда; зрізи різних джерел не сумуються)']);
  const snaps = latestStoreSnapshots_();
  if (!snaps.length) add('n', ['Показники ще не внесені.', '', '', 'Див. інструкцію в README (крок про аналітику магазинів).']);
  else {
    add('th', ['Платформа', 'Метрика (як у джерелі)', 'Значення', 'Одиниця', 'Період', 'Доступність', 'Отримано', 'Що це означає', 'Примітка']);
    snaps.forEach(function (s) {
      const r = s.row;
      const kind = storeMetricKind_(r);
      const v = parseMetricValue_(r.value);
      const avail = r.availability || (v === null ? 'unavailable' : 'available');
      add('n', [r.platform || '—', r.metric_name || '—', v === null ? 'невідомо' : v, r.unit || '—', (r.period_from || '?') + ' — ' + (r.period_to || '?') + (r.source_timezone ? ' (' + r.source_timezone + ')' : ''),
        avail, r.retrieved_at || '—', kind.note, s.overlap ? 'Є інший зріз цієї метрики з перекривним періодом: не сумується, показано актуальний.' : (v === null && avail === 'available' ? 'Значення порожнє: це "невідомо", а не нуль.' : '')]);
    });
  }
  add('note', ['Telegram не повідомляє боту про звичайний перехід за URL-кнопкою: кліки в боті не вимірюються. Android і iOS (різні одиниці магазинів) не сумуються як "унікальні люди".']);
  add('gap', []);

  // 9. Атрибуція й налаштування
  add('h', ['9. НЕЗАВЕРШЕНІ НАЛАШТУВАННЯ']);
  const todo = [];
  if (!S.APPLE_PROVIDER_TOKEN) todo.push(['Apple provider token не задано', 'iOS-посилання працюють, але без тегу кампанії: атрибуція iOS не налаштована (ios_link_tagged=false).']);
  if (!S.FILE_VIEWER_BASE_URL) todo.push(['FILE_VIEWER_BASE_URL порожній', 'Команда не побачить посилань перегляду вкладень (див. README).']);
  if (S.TEST_MODE) todo.push(['TEST_MODE=true', 'Бот відповідає лише чатам із TEST_CHAT_ALLOWLIST. Для запуску: TEST_MODE=false.']);
  if (!S.DELIVERY_ENABLED) todo.push(['DELIVERY_ENABLED=false', 'Розсилка справжнім учасникам заборонена. Для запуску: DELIVERY_ENABLED=true.']);
  if (S.DEFAULT_TRIAL_DAYS !== 14 || S.DAY5_NUDGE_DAY !== 5) todo.push(['Скорочені налаштування тесту', 'DEFAULT_TRIAL_DAYS=' + S.DEFAULT_TRIAL_DAYS + ', DAY5_NUDGE_DAY=' + S.DAY5_NUDGE_DAY + ' (за планом 14 і 5).']);
  if (G().settingsProblems && G().settingsProblems.length) todo.push(['Проблеми в "Налаштування"', G().settingsProblems.join('; ')]);
  if (!todo.length) add('n', ['Немає.']);
  todo.forEach(function (t) { add('n', t); });
  add('gap', []);

  // 10. Система
  add('h', ['10. РОБОТА БОТА']);
  add('n', ['Останній запуск (хв тому)', m.lastTickMin === null ? '—' : m.lastTickMin, m.lastTickOk ? 'останній запуск без помилки' : 'останній запуск з ПОМИЛКОЮ']);
  add('n', ['Черга вихідних (у вікні перегляду)', Object.keys(m.outbox).map(function (k) { return k + '=' + m.outbox[k]; }).join(', ') || 'порожня']);
  add('n', ['Вхідні (у вікні перегляду)', Object.keys(m.inbox).map(function (k) { return k + '=' + m.inbox[k]; }).join(', ') || 'порожньо']);
  add('n', ['Відкриті інциденти', m.incidents.length]);
  m.incidents.slice(0, 5).forEach(function (r) { add('n', ['  ' + (r.component || '') + '/' + (r.error_code || ''), trunc_(r.safe_summary || '', 120), 'з ' + (r.created_at || '—') + ', повторів: ' + (r.occurrences || 1)]); });

  const out = rows.map(function (r) {
    const row = r.slice(0, W).map(sheetSafe_);
    while (row.length < W) row.push('');
    return row;
  });
  return { rows: out, styles: styles, width: W };
}

function overviewHash_(rows) {
  // рядок 2 містить час оновлення — не враховуємо
  return sha256Hex_(JSON.stringify(rows.filter(function (r, i) { return i !== 1; })));
}

function renderOverview_(built) {
  const ss = openSpreadsheet_();
  const sh = ss.getSheetByName(SCHEMA.OVERVIEW.name);
  if (!sh) return false;
  const N = built.rows.length, W = built.width;
  if (sh.getMaxRows() < N + 5) sh.insertRowsAfter(sh.getMaxRows(), N + 5 - sh.getMaxRows());
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  const last = sh.getLastRow();
  if (last > N) sh.getRange(N + 1, 1, last - N, W).clearContent();
  sh.getRange(1, 1, N, W).setValues(built.rows);
  built.styles.forEach(function (st, i) {
    const rng = function () { return sh.getRange(i + 1, 1, 1, W); };
    if (st === 'title') tryDo_(function () { rng().setFontWeight('bold').setFontSize(16); });
    else if (st === 'h') tryDo_(function () { rng().setFontWeight('bold').setBackground('#d2e3fc'); });
    else if (st === 'th') tryDo_(function () { rng().setFontWeight('bold').setBackground('#e8eaed').setWrap(true); });
    else if (st === 'note') tryDo_(function () { rng().setFontColor('#5f6368'); });
  });
  tryDo_(function () { sh.setColumnWidth(1, 430); });
  return true;
}

/** Колонки "Етап воронки" і "Що далі" в "Учасники": один масовий запис на колонку (лише якщо щось змінилося). */
function writeFunnelColumns_(S, now) {
  const pt = participants_();
  if (!pt.rows.length) return 0;
  const surveyBy = {};
  surveys_().rows.forEach(function (s) {
    const cur = surveyBy[s.participant_id];
    if (!cur || (parseIso_(s.started_at) || 0) >= (parseIso_(cur.started_at) || 0)) surveyBy[s.participant_id] = s;
  });
  const rewardBy = {};
  rewards_().rows.forEach(function (r) { rewardBy[r.participant_id] = r; });
  const sh = pt.sheet();
  const rowsSorted = pt.rows.slice().sort(function (a, b) { return a._row - b._row; });
  const minRow = rowsSorted[0]._row, maxRow = rowsSorted[rowsSorted.length - 1]._row;
  let changed = 0;
  [['funnel_stage', 'stage'], ['funnel_note', 'note']].forEach(function (c) {
    const idx = pt.colIdx(c[0]);
    const rng = sh.getRange(minRow, idx, maxRow - minRow + 1, 1);
    const cur = rng.getValues();
    let dirty = false;
    rowsSorted.forEach(function (p) {
      const st = funnelStageOf_(p, { survey: surveyBy[p.participant_id] || null, reward: rewardBy[p.participant_id] || null }, S, now);
      const nv = sheetSafe_(st[c[1]]);
      if (String(cur[p._row - minRow][0] === null ? '' : cur[p._row - minRow][0]) !== nv) { cur[p._row - minRow][0] = nv; dirty = true; }
      p[c[0]] = nv;                       // кеш у пам'яті
    });
    if (dirty) { rng.setValues(cur); changed++; }
  });
  return changed;
}

/** Викликається з tick_ після обробки: не частіше за OVERVIEW_REFRESH_MINUTES. force=true — негайно. */
function refreshOverview_(S, force) {
  const now = nowMs_();
  const last = parseIso_(propGet_(PROP.OVERVIEW_AT));
  if (!force && last !== null && now - last < S.OVERVIEW_REFRESH_MINUTES * 60000) return false;
  const m = collectMetrics_(S, now);
  const built = buildOverviewRows_(m, S, now);
  const h = overviewHash_(built.rows);
  if (force || h !== propGet_(PROP.OVERVIEW_HASH)) {
    renderOverview_(built);
    propSet_(PROP.OVERVIEW_HASH, h);
  }
  writeFunnelColumns_(S, now);
  propSet_(PROP.OVERVIEW_AT, isoSec_(now));
  return true;
}

/** Безпечна обгортка для tick: збій аналітики не ламає роботу бота. */
function safeRefreshOverview_(S) {
  try { refreshOverview_(S, false); recoverIncident_('analytics', 'overview_failed', ''); }
  catch (e) { reportIncident_('analytics', 'overview_failed', 'Не вдалося оновити "Огляд": ' + trunc_(scrub_(e && e.message), 200), { level: 'warn' }); }
}

// ---------- /stats для власника ----------
function ownerStatsText_() {
  const S = settings_();
  const m = collectMetrics_(S, nowMs_());
  const lines = ['Mimeon alpha — воронка (без тестових, ' + m.realCount + ' учасників)'];
  const first = m.funnel[0].all;
  m.funnel.forEach(function (f, i) {
    lines.push((i + 1) + '. ' + f.label + ': ' + f.all + (i === 0 ? '' : ' (' + pct_(f.all, m.funnel[i - 1].all) + ' від попер., ' + pct_(f.all, first) + ' від усіх)'));
  });
  lines.push('Фідбек отримано: ' + m.feedback + ' з ' + m.feedbackDenominator + ' з доставленим посиланням (' + pct_(m.feedback, m.feedbackDenominator) + ')');
  lines.push('Чекають місця: ' + m.waiting + '; відмовились: ' + m.declined + '; заблокували бота: ' + m.blocked + '; вимкнули повідомлення: ' + m.optedOut);
  lines.push('Анкети: завершені ' + m.surveys.completed + ', часткові ' + m.surveys.partial);
  lines.push('Звернення: відкриті ' + m.tickets.openRegular + ' звичайних + ' + m.tickets.openCritical + ' КРИТИЧНИХ; без відповіді понад ' + S.SUPPORT_FIRST_RESPONSE_HOURS + ' год: ' + m.tickets.overdue);
  const ch = m.rewards.byChoice;
  lines.push('Подяки обрано: преміум ' + (ch.premium_month || 0) + ', результати ' + (ch.research_results || 0) + ', публічна подяка ' + (ch.public_thanks || 0));
  const att = [];
  if (m.attention.noConsent24h) att.push('без згоди >24 год: ' + m.attention.noConsent24h);
  if (m.attention.noLink24h) att.push('без посилання >24 год: ' + m.attention.noLink24h);
  if (m.attention.invitedNotStarted) att.push('запрошені в анкету, не почали: ' + m.attention.invitedNotStarted);
  if (m.outbox.delivery_unknown) att.push('delivery_unknown: ' + m.outbox.delivery_unknown);
  if (m.outbox.failed) att.push('failed: ' + m.outbox.failed);
  if (m.incidents.length) att.push('інциденти: ' + m.incidents.length);
  lines.push('Увага: ' + (att.length ? att.join('; ') : 'нічого термінового'));
  lines.push('Деталі й розбивка за платформами: аркуш "Огляд".\n' + sheetUrl_('OVERVIEW'));
  return lines.join('\n');
}
