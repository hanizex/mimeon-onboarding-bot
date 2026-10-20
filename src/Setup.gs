/**
 * Setup.gs — одноразове налаштування та діагностика (запускаються власником у редакторі Apps Script).
 *
 *  bootstrap_()        створює/доповнює таблицю: аркуші, заголовки, формати, валідацію, нотатки, захист. Безпечно повторювати.
 *  setup_()            перевіряє getMe і webhook, створює рівно один тригер tick_ у SETUP_MODE, видає одноразовий код прив'язки.
 *  migrate_()          додає відсутні колонки/налаштування без очищення даних.
 *  healthCheck_()      короткий звіт стану.
 *  measureTickCost_()  виконує один tick і виводить фактичні витрати часу/викликів (для перевірки квот).
 *
 * Усі функції закінчуються "_" (приватні): не викликаються з HTML через google.script.run.
 * Якщо редактор не показує приватні функції у списку запуску — див. Launcher.gs та README.
 */

function tryDo_(fn) { try { return fn(); } catch (e) { return null; } }

// ---------- Таблиця ----------
function bootstrap_() {
  resetCtx_();
  let ss;
  const id = propGet_(PROP.SPREADSHEET_ID);
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('Mimeon alpha — супровід (UA)');
    propSet_(PROP.SPREADSHEET_ID, ss.getId());
  }
  G().ss = ss;
  ensureSchema_(ss);
  seedSettings_();
  if (!propGet_(PROP.VIEWER_SIGNING_SECRET)) {
    propSet_(PROP.VIEWER_SIGNING_SECRET, sha256Hex_(Utilities.getUuid() + Utilities.getUuid()) + sha256Hex_(Utilities.getUuid()).slice(0, 16));
  }
  propSet_(PROP.SCHEMA_VERSION, SCHEMA_VERSION);
  applyProtection_(ss);
  Logger.log('bootstrap_ завершено. SPREADSHEET_ID=' + ss.getId() + '\nПосилання: ' + ss.getUrl() +
    '\nТаблицю НЕ робіть публічною за посиланням. Доступ надавайте лише членам команди (не додавайте їх до редакторів скрипта).');
  return ss.getId();
}

function migrate_() {
  const ss = openSpreadsheet_();
  ensureSchema_(ss);
  seedSettings_();
  propSet_(PROP.SCHEMA_VERSION, SCHEMA_VERSION);
  resetCtxTables_();
  tryDo_(function () { applyBotProfile_(); });         // не критично: профіль бота не заважає міграції
}

/**
 * Профіль бота в Telegram: короткий опис («Про бота» у профілі), повний опис (екран перед /start) і меню команд.
 * Тексти — шаблони bot_short_description / bot_description в аркуші «Налаштування»; змінили — запустіть ще раз
 * (run_applyBotProfile або команда власника /botprofile). Лише українською.
 * Повертає {ok, failed:[...]}.
 */
function applyBotProfile_() {
  const short = trunc_(renderTemplate_('bot_short_description'), 120);
  const full = trunc_(renderTemplate_('bot_description'), 512);
  const calls = [
    ['setMyShortDescription', { short_description: short }],
    ['setMyDescription', { description: full }],
    ['setMyCommands', { commands: BOT_COMMANDS.map(function (c) { return { command: c[0], description: c[1] }; }) }]
  ];
  const failed = [];
  calls.forEach(function (c) {
    const r = tgCall_(c[0], c[1]);
    if (!r.ok) failed.push(c[0] + ': ' + (r.description || r.kind));
  });
  return { ok: failed.length === 0, failed: failed };
}
function resetCtxTables_() {
  const c = G();
  c.tables = {}; c.settings = null; c.templates = null; c.outboxKeys = null;
}

function ensureSchema_(ss) {
  const order = ['START', 'OVERVIEW', 'PARTICIPANTS', 'TICKETS', 'MESSAGES', 'REPLIES', 'ATTACHMENTS', 'SURVEYS', 'ANSWERS',
    'REWARDS', 'STORE_METRICS', 'REPORT', 'SETTINGS', 'INBOX', 'OUTBOX', 'TECHLOG', 'GUIDE'];
  order.forEach(function (key, idx) {
    const schema = SCHEMA[key];
    let sh = ss.getSheetByName(schema.name);
    if (!sh) {
      const sheets = ss.getSheets();
      if (idx === 0 && sheets.length === 1 && sheets[0].getLastRow() === 0 && !ss.getSheetByName('Старт')) { sh = sheets[0]; sh.setName(schema.name); }
      else sh = ss.insertSheet(schema.name);
    }
    if (schema.kind === 'doc') { writeDocSheet_(sh, key); return; }
    ensureTableSheet_(ss, sh, schema);
  });
  // прибрати порожній типовий аркуш, якщо лишився
  const dflt = ss.getSheetByName('Sheet1') || ss.getSheetByName('Аркуш1');
  if (dflt && dflt.getLastRow() === 0 && ss.getSheets().length > 1) tryDo_(function () { ss.deleteSheet(dflt); });
}

function ensureTableSheet_(ss, sh, schema) {
  const cols = schema.columns;
  let lastCol = sh.getLastColumn();
  let keys = [];
  if (lastCol > 0 && sh.getLastRow() >= 2) keys = sh.getRange(2, 1, 1, lastCol).getValues()[0].map(function (k) { return String(k || '').trim(); });
  // додаємо відсутні колонки в кінець; наявні не переставляємо й не чистимо
  cols.forEach(function (c) {
    if (keys.indexOf(c.key) < 0) {
      const idx = keys.filter(function (k) { return k !== ''; }).length + 1;
      if (idx > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), idx - sh.getMaxColumns());
      sh.getRange(2, idx).setValue(c.key);
      sh.getRange(1, idx).setValue(c.label);
      keys.push(c.key);
    }
  });
  lastCol = keys.length;
  // оновлюємо підписи й нотатки (дані не чіпаємо)
  const labels = [], notes = [];
  keys.forEach(function (k) {
    const c = cols.filter(function (x) { return x.key === k; })[0];
    labels.push(c ? c.label : k);
    notes.push(c ? (c.note || '') + (c.writable ? '\n[Редагується командою]' : '\n[Системна колонка — захищена]') + '\nКлюч: ' + c.key : '');
  });
  sh.getRange(1, 1, 1, lastCol).setValues([labels]);
  sh.getRange(1, 1, 1, lastCol).setNotes([notes]);
  sh.getRange(2, 1, 1, lastCol).setValues([keys]);
  if (sh.getMaxRows() < 1000) sh.insertRowsAfter(sh.getMaxRows(), 1000 - sh.getMaxRows());
  tryDo_(function () { sh.setFrozenRows(2); });
  tryDo_(function () { sh.getRange(1, 1, 1, lastCol).setFontWeight('bold').setBackground('#e8eaed').setWrap(true).setVerticalAlignment('middle'); });
  tryDo_(function () { sh.getRange(2, 1, 1, lastCol).setFontColor('#80868b').setFontSize(8); });
  // розмітка редагованих колонок
  keys.forEach(function (k, i) {
    const c = cols.filter(function (x) { return x.key === k; })[0];
    if (c && c.writable) tryDo_(function () { sh.getRange(1, i + 1).setBackground('#fff2cc'); });
    tryDo_(function () { sh.setColumnWidth(i + 1, c && c.type === 'j' ? 260 : (c && c.key.indexOf('text') >= 0 ? 360 : 150)); });
  });
  tryDo_(function () { if (!sh.getFilter()) sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 2), lastCol).createFilter(); });
  // формати та валідація — через Table (за ключами в рядку 2)
  const tbl = new Table(G(), schema);
  tbl._sheet = sh;
  applyColumnFormats_(tbl, 3, sh.getMaxRows());
}

function writeDocSheet_(sh, key) {
  if (sh.getLastRow() > 0) return;     // вміст аркуша-інструкції не перезаписуємо
  let rows;
  if (key === 'START') {
    rows = [
      ['Mimeon alpha — супровід української альфи'],
      ['Версія коду: ' + APP_VERSION + '. Мова: українська.'],
      [''],
      ['ЩО РОБИТИ КОМАНДІ (щодня, ~5 хвилин)'],
      ['1. Відкрийте "Звернення": нові рядки зі статусом new; критичні виділені (critical_by_user=true).'],
      ['2. Для відповіді: у "Відповіді" додайте рядок — ticket_id, текст, автор — і поставте галочку "Надіслати".'],
      ['3. Змініть статус і відповідального у "Звернення". Внутрішні примітки учаснику НЕ надсилаються.'],
      ['4. Перевірте "Огляд": відкриті/прострочені (понад 72 год) звернення та стан автоматизації.'],
      ['5. Раз на кілька днів вносьте показники магазинів в "Аналітика магазинів" (порожнє значення = невідомо, НЕ нуль).'],
      [''],
      ['ЧОГО НЕ РОБИТИ'],
      ['• Не сортуйте й не видаляйте рядки у службових аркушах (Вхідні, Вихідні, Техжурнал): вони захищені.'],
      ['• Не публікуйте таблицю за посиланням. Не додавайте членів команди до редакторів Apps Script (там токен бота).'],
      ['• Відповідь, що вже надіслана, не змінюється редагуванням: для нової відповіді створіть новий рядок.'],
      [''],
      ['АРКУШІ'],
      ['Огляд — показники; Учасники — реєстр; Звернення — черга підтримки; Повідомлення — хронологія; Відповіді — відповіді команди;'],
      ['Вкладення — перегляд файлів; Опитування / Відповіді анкети — фінальне опитування; Винагороди — вибір і виконання;'],
      ['Аналітика магазинів — зведення Google Play / App Store; Звіт для учасників — текст звіту; Налаштування — параметри, шаблони, FAQ;'],
      ['Гайд — розділи гайда в боті (текст, скриншот-посилання, порядок); Вхідні / Вихідні — черги Telegram; Техжурнал — інциденти.'],
      [''],
      ['СЛОВНИК СТАТУСІВ'],
      ['Участь: onboarding, waiting_capacity, active, awaiting_feedback, finished, withdrawn.'],
      ['Доставка (Вихідні): queued, sending, sent, retry_wait, failed, delivery_unknown, cancelled.'],
      ['delivery_unknown: Telegram міг прийняти повідомлення, але відповідь загубилась. Перевірте чат; виберіть у "operator_action" "mark_delivered_verified" (є в чаті) або "retry_verified" (немає).'],
      ['Звернення: new, in_progress, waiting_user, resolved, closed.'],
      [''],
      ['Пояснення кожної колонки — у примітках до заголовків (наведіть курсор на комірку в першому рядку).']
    ];
  } else {
    rows = [
      ['Огляд'],
      ['Показники з\'являться тут автоматично (етап 3). Поки що стан роботи див. у "Техжурнал" та у відповіді бота на /status (чат власника).']
    ];
  }
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
  tryDo_(function () { sh.getRange(1, 1).setFontWeight('bold').setFontSize(14); });
  tryDo_(function () { sh.setColumnWidth(1, 900); });
}

function seedSettings_() {
  const tbl = table_('SETTINGS');
  tbl.load(3);
  const have = {};
  tbl.rows.forEach(function (r) { have[r.kind + '|' + r.key] = true; });
  const add = [];
  SETTINGS_DEF.forEach(function (d) {
    if (have['param|' + d[0]]) return;
    let v = d[2];
    if (d[1] === 'l') v = String(d[2]);
    add.push({ kind: 'param', key: d[0], value: String(v), description: d[3] });
  });
  Object.keys(TEMPLATE_DEF).forEach(function (name) {
    if (have['template|' + name]) return;
    const def = TEMPLATE_DEF[name];
    add.push({ kind: 'template', key: name, value: def.text,
      description: 'Шаблон. Дозволені placeholders: ' + (def.placeholders.length ? def.placeholders.map(function (p) { return '{{' + p + '}}'; }).join(', ') : 'немає') + '. Недозволені або порожні — шаблон ігнорується.' });
  });
  FAQ_DEF.forEach(function (f) {
    if (have['faq|' + f[0]]) return;
    add.push({ kind: 'faq', key: f[0], value: f[1], description: 'Початкова відповідь FAQ.' });
  });
  if (add.length) tbl.appendMany(add);
  seedGuide_();
  upgradeDefaultTexts_();
}

/** Замінює старі СТАНДАРТНІ тексти новими (див. TEXT_UPGRADES). Змінені командою тексти не чіпає. */
function upgradeDefaultTexts_() {
  const norm = function (x) { return String(x === null || x === undefined ? '' : x).replace(/\r\n/g, '\n').trim(); };
  const sTbl = table_('SETTINGS'); sTbl.load(3);
  const gTbl = table_('GUIDE'); gTbl.load(3);
  TEXT_UPGRADES.forEach(function (u) {
    if (u.kind === 'template' || u.kind === 'param') {
      const r = sTbl.find(function (x) { return x.kind === u.kind && x.key === u.key; });
      if (r && norm(r.value) === norm(u.old)) sTbl.update(r, { value: u.now });
    } else if (u.kind === 'guide') {
      const r = gTbl.find(function (x) { return x.page_id === u.key; });
      if (r && norm(r.text) === norm(u.old)) gTbl.update(r, { text: u.now });
    }
  });
}

/** Початкові сторінки гайда — лише в порожній аркуш (видалені командою сторінки не повертаються). */
function seedGuide_() {
  const g = table_('GUIDE');
  g.load(3);
  if (g.rows.length) return;
  g.appendMany(GUIDE_DEF.map(function (d) { return { page_id: d[0], order: d[1], title: d[2], text: d[3], image_url: null, enabled: true }; }));
}

/** Захист: системні колонки — лише власник; редаговані колонки команди — незахищені діапазони. Потребує перевірки наживо. */
function applyProtection_(ss) {
  Object.keys(SCHEMA).forEach(function (key) {
    const schema = SCHEMA[key];
    const sh = ss.getSheetByName(schema.name);
    if (!sh) return;
    tryDo_(function () {
      sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (pr) {
        if (String(pr.getDescription()).indexOf('MIM:') === 0) pr.remove();
      });
      const pr = sh.protect().setDescription('MIM: захищено автоматизацією');
      const unprotected = [];
      if (schema.kind === 'table') {
        const keys = sh.getRange(2, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
        schema.columns.forEach(function (c) {
          if (!c.writable) return;
          const idx = keys.indexOf(c.key);
          if (idx >= 0) unprotected.push(sh.getRange(3, idx + 1, Math.max(sh.getMaxRows() - 2, 1), 1));
        });
      }
      if (unprotected.length) pr.setUnprotectedRanges(unprotected);
      const me = Session.getEffectiveUser();
      pr.addEditor(me);
      const editors = pr.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); });
      if (editors.length) pr.removeEditors(editors);
      if (pr.canDomainEdit()) pr.setDomainEdit(false);
    });
  });
}

// ---------- Тригер ----------
/** Рівно один тригер tick_. Дублікати видаляються. Повертає кількість після операції. */
function ensureTrigger_() {
  const all = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tick_'; });
  for (let i = 1; i < all.length; i++) ScriptApp.deleteTrigger(all[i]);
  if (!all.length) ScriptApp.newTrigger('tick_').timeBased().everyMinutes(1).create();
  return ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tick_'; }).length;
}

// ---------- Налаштування бота та прив'язка власника ----------
function setup_(opts) {
  opts = opts || {};
  resetCtx_();
  if (!propGet_(PROP.SPREADSHEET_ID)) throw new SafeError('no_spreadsheet', 'Спочатку запустіть bootstrap_().');
  if (propGet_(PROP.OWNER_CHAT_ID) && !opts.rebind) {
    throw new SafeError('already_bound', 'Власника вже прив\'язано. Повторна прив\'язка — лише явною дією: запустіть setupRebindOwner_().');
  }
  const me = tgGetMe_();
  if (!me.ok) throw new SafeError('getme_failed', 'getMe не пройшов (' + me.kind + '): перевірте BOT_TOKEN.');
  propSet_(PROP.BOT_ID, me.result.id);
  const sTbl = table_('SETTINGS').load(3);
  const botRow = sTbl.find(function (r) { return r.kind === 'param' && r.key === 'BOT_USERNAME'; });
  if (botRow) sTbl.update(botRow, { value: me.result.username || '' });
  Logger.log('Налаштовується бот: @' + me.result.username + ' (id ' + me.result.id + ', "' + me.result.first_name + '"). Це має бути УЖЕ СТВОРЕНИЙ бот Mimeon.');

  const wh = tgGetWebhookInfo_();
  if (!wh.ok) throw new SafeError('webhook_info_failed', 'getWebhookInfo не пройшов (' + wh.kind + ').');
  if (wh.result && wh.result.url) {
    let host = '(невідомо)';
    tryDo_(function () { host = /^https?:\/\/([^\/]+)/.exec(wh.result.url)[1]; });
    if (propGet_(PROP.CONFIRM_DELETE_WEBHOOK) !== 'yes') {
      throw new SafeError('webhook_active', 'У бота активний webhook (хост ' + host + ', непрочитаних updates: ' + wh.result.pending_update_count +
        '). Якщо цей бот належить іншій активній автоматизації — НЕ продовжуйте. Якщо ні — задайте у Script Properties CONFIRM_DELETE_WEBHOOK=yes і запустіть setup_() ще раз. Webhook буде відключено БЕЗ втрати непрочитаних updates.');
    }
    const del = tgDeleteWebhookKeepUpdates_();
    if (!del.ok) throw new SafeError('delete_webhook_failed', 'Не вдалося відключити webhook (' + del.kind + ').');
    const wh2 = tgGetWebhookInfo_();
    if (wh2.ok && wh2.result && wh2.result.url) throw new SafeError('webhook_still_active', 'Webhook усе ще активний після deleteWebhook.');
    propDelete_(PROP.CONFIRM_DELETE_WEBHOOK);
  }
  if (opts.rebind) { propDelete_(PROP.OWNER_CHAT_ID); propDelete_(PROP.OWNER_TELEGRAM_USER_ID); }
  const code = randomCode_(8);
  propSetMany_({
    SETUP_BIND_HASH: sha256Hex_(code), SETUP_BIND_EXPIRES: isoSec_(nowMs_() + 15 * 60000), SETUP_MODE: 'true'
  });
  const n = ensureTrigger_();
  Logger.log('Тригер tick_: ' + n + ' (має бути 1). SETUP_MODE увімкнено.\n' +
    'Тепер у ПРИВАТНОМУ чаті з ботом надішліть: /bind_owner ' + code + '\nКод діє 15 хвилин і спрацює один раз. Після підтвердження прив\'язки SETUP_MODE вимкнеться сам.');
  return { botUsername: me.result.username, triggers: n };
}
function setupRebindOwner_() { return setup_({ rebind: true }); }

// ---------- Діагностика ----------
function healthCheck_() {
  resetCtx_();
  const out = [];
  out.push('Версія коду: ' + APP_VERSION + ', схема ' + SCHEMA_VERSION + ' (у проєкті: ' + (propGet_(PROP.SCHEMA_VERSION) || '—') + ')');
  const triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'tick_'; }).length;
  out.push('Тригерів tick_: ' + triggers + (triggers === 1 ? ' (ок)' : ' (ПОТРІБЕН РІВНО 1)'));
  out.push('SETUP_MODE: ' + (propGet_(PROP.SETUP_MODE) === 'true' ? 'увімкнено' : 'вимкнено'));
  out.push('Власник прив\'язаний: ' + (propGet_(PROP.OWNER_CHAT_ID) ? 'так' : 'ні'));
  const wh = tgGetWebhookInfo_();
  out.push('Webhook: ' + (wh.ok ? (wh.result.url ? 'АКТИВНИЙ (конфлікт з polling!)' : 'немає (ок)') : 'не вдалося перевірити (' + wh.kind + ')'));
  tryDo_(function () {
    const S = settings_();
    out.push('TEST_MODE=' + S.TEST_MODE + ', DELIVERY_ENABLED=' + S.DELIVERY_ENABLED + ', MAX_PARTICIPANTS=' + S.MAX_PARTICIPANTS);
    if (G().settingsProblems.length) out.push('Проблеми налаштувань: ' + G().settingsProblems.join('; '));
    out.push('Apple provider token: ' + (S.APPLE_PROVIDER_TOKEN ? 'задано' : 'НЕ задано (iOS-посилання без тегу)'));
  });
  out.push('Останній запуск: ' + (propGet_(PROP.LAST_TICK_AT) || '—') + ' | ' + (propGet_(PROP.LAST_TICK_JSON) || ''));
  Logger.log(out.join('\n'));
  return out;
}

/** Виконує один tick і виводить фактичні витрати. Запустіть у порожньому стані й під час активних повідомлень. */
function measureTickCost_() {
  const t0 = Date.now();
  tick_();
  const info = safeJsonParse_(propGet_(PROP.LAST_TICK_JSON), {});
  const dur = Date.now() - t0;
  const perDayMin = Math.round(dur / 1000 * 1440 / 60);
  Logger.log('Tick: ' + dur + ' мс, API-викликів Telegram: ' + (info.metrics && info.metrics.apiCalls) +
    '. При такому часі 1440 запусків/добу ≈ ' + perDayMin + ' хв/добу (ліміт: звичайний акаунт 90 хв, Workspace 360 хв).');
  return { ms: dur, minutesPerDay: perDayMin };
}
