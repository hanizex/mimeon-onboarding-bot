/**
 * Storage.gs — контекст виконання, Script Properties, типізований доступ до Sheets,
 * налаштування з аркуша, журнал інцидентів.
 *
 * Принципи:
 *  - рядок таблиці НІКОЛИ не є ключем: усі посилання за ID, перед записом позиція рядка перевіряється;
 *  - Sheets не має транзакцій між аркушами: нижче немає "атомарних" операцій, лише ідемпотентні кроки;
 *  - null = порожня клітинка; false/0 — явні значення.
 */

// ---------- Контекст одного виконання ----------
var G_ = null;
function G() {
  if (!G_) G_ = newCtx_();
  return G_;
}
function resetCtx_() { G_ = null; }

function newCtx_() {
  const props = PropertiesService.getScriptProperties();
  return {
    props: props,
    propMap: props.getProperties(),
    ss: null,
    tables: {},
    settings: null,
    settingsProblems: [],
    templates: null,
    startedMs: nowMs_(),
    sends: 0,
    metrics: { updates: 0, events: 0, sent: 0, failed: 0, retried: 0, apiCalls: 0, errors: 0 },
    correlationId: correlationId_()
  };
}

// ---------- Script Properties ----------
function propGet_(key) {
  const v = G().propMap[key];
  return (v === undefined || v === null || v === '') ? null : v;
}
function propSet_(key, value) {
  const c = G();
  c.props.setProperty(key, String(value));
  c.propMap[key] = String(value);
}
function propDelete_(key) {
  const c = G();
  c.props.deleteProperty(key);
  delete c.propMap[key];
}

// ---------- Конвертація значень клітинок ----------
function fromCell_(col, v) {
  if (v === '' || v === null || v === undefined) return null;
  switch (col.type) {
    case 'b':
      if (v === true || v === false) return v;
      if (String(v).toLowerCase() === 'true') return true;
      if (String(v).toLowerCase() === 'false') return false;
      return null;
    case 'n': {
      if (typeof v === 'number') return v;
      const n = Number(v);
      return isNaN(n) ? null : n;
    }
    default:
      if (v instanceof Date) return v.toISOString();
      return String(v);
  }
}
function toCell_(col, v) {
  if (v === null || v === undefined) return '';
  switch (col.type) {
    case 'b': return v === true || v === false ? v : (String(v).toLowerCase() === 'true');
    case 'n': return typeof v === 'number' ? v : Number(v);
    case 'j': return typeof v === 'string' ? v : JSON.stringify(v);
    default: return String(v);
  }
}
function isTextLike_(col) { return col.type === 's' || col.type === 'd' || col.type === 'j'; }

// ---------- Таблиця ----------
class Table {
  constructor(ctx, schema) {
    this.ctx = ctx;
    this.schema = schema;
    this.id = schema.id || null;
    this._sheet = null;
    this._keys = null;
    this._colIndex = null;
    this.rows = [];
    this.fromRow = 3;
    this.loaded = false;
    this.lastVerifyMs = 0;
    this.byId = {};
  }
  sheet() {
    if (!this._sheet) {
      const ss = openSpreadsheet_();
      const sh = ss.getSheetByName(this.schema.name);
      if (!sh) throw new SafeError('schema_missing', 'Немає аркуша "' + this.schema.name + '". Запустіть bootstrap_().');
      this._sheet = sh;
    }
    return this._sheet;
  }
  keys() {
    if (!this._keys) {
      const sh = this.sheet();
      const lastCol = Math.max(sh.getLastColumn(), 1);
      this._keys = sh.getRange(2, 1, 1, lastCol).getValues()[0].map(function (k) { return String(k || '').trim(); });
      this._colIndex = {};
      for (let i = 0; i < this._keys.length; i++) if (this._keys[i]) this._colIndex[this._keys[i]] = i + 1;
      this.schema.columns.forEach(function (c) {
        if (!this._colIndex[c.key]) throw new SafeError('schema_column_missing', 'У "' + this.schema.name + '" немає колонки ' + c.key + '. Запустіть migrate_().');
      }, this);
    }
    return this._keys;
  }
  colIdx(key) { this.keys(); return this._colIndex[key]; }
  col(key) {
    for (let i = 0; i < this.schema.columns.length; i++) if (this.schema.columns[i].key === key) return this.schema.columns[i];
    throw new SafeError('unknown_column', 'Невідома колонка ' + key);
  }
  /** Остання рядок із даними (для аркушів із попередньо заповненими чекбоксами — за колонкою ID). */
  lastDataRow() {
    const sh = this.sheet();
    if (this.schema.scanLast && this.id) {
      const max = sh.getMaxRows();
      if (max < 3) return 2;
      const vals = sh.getRange(3, this.colIdx(this.id), max - 2, 1).getValues();
      let last = 2;
      for (let i = vals.length - 1; i >= 0; i--) if (vals[i][0] !== '' && vals[i][0] !== null) { last = i + 3; break; }
      return last;
    }
    return Math.max(sh.getLastRow(), 2);
  }
  /** Читає рядки [fromRow..останній]. Для великих "журнальних" аркушів fromRow — водяний знак. */
  load(fromRow) {
    fromRow = Math.max(3, fromRow || 3);
    const sh = this.sheet();
    this.keys();
    const last = this.lastDataRow();
    this.rows = [];
    this.byId = {};
    this.fromRow = fromRow;
    if (last >= fromRow) {
      const width = this._keys.length;
      const vals = sh.getRange(fromRow, 1, last - fromRow + 1, width).getValues();
      const idCol = this.id ? this._colIndex[this.id] - 1 : -1;
      for (let i = 0; i < vals.length; i++) {
        if (this.id && (vals[i][idCol] === '' || vals[i][idCol] === null)) continue;   // порожній/службово порожній рядок
        const o = this._toObj(vals[i], fromRow + i);
        this.rows.push(o);
        if (this.id) this.byId[o[this.id]] = o;
      }
    }
    this.loaded = true;
    this.lastVerifyMs = nowMs_();
    return this;
  }
  _toObj(arr, rowNum) {
    const o = { _row: rowNum };
    const cols = this.schema.columns;
    for (let i = 0; i < cols.length; i++) {
      const idx = this._colIndex[cols[i].key] - 1;
      o[cols[i].key] = fromCell_(cols[i], arr[idx]);
    }
    return o;
  }
  ensureLoaded(fromRow) { if (!this.loaded) this.load(fromRow); return this; }
  all() { this.ensureLoaded(); return this.rows; }
  get(id) { this.ensureLoaded(); return this.byId[id] || null; }
  find(fn) { this.ensureLoaded(); for (let i = 0; i < this.rows.length; i++) if (fn(this.rows[i])) return this.rows[i]; return null; }
  filter(fn) { this.ensureLoaded(); return this.rows.filter(fn); }
  /** Повна колонка значень (без заголовків) — дешеві індекси ключів. */
  readColumn(key, fromRow) {
    const sh = this.sheet();
    this.keys();
    const last = this.lastDataRow();
    fromRow = Math.max(3, fromRow || 3);
    if (last < fromRow) return [];
    return sh.getRange(fromRow, this.colIdx(key), last - fromRow + 1, 1).getValues().map(function (r) { return r[0]; });
  }

  /** Перевіряє, що кешовані позиції рядків ще правильні (людина могла відсортувати/додати рядки). */
  verifyFresh() {
    if (!this.id || !this.loaded) return;
    const now = nowMs_();
    if (now - this.lastVerifyMs < 1500) return;
    this.lastVerifyMs = now;
    const sh = this.sheet();
    const last = this.lastDataRow();
    const count = Math.max(0, last - this.fromRow + 1);
    let ids = count ? sh.getRange(this.fromRow, this.colIdx(this.id), count, 1).getValues().map(function (r) { return r[0]; }) : [];
    let ok = true;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]._row - this.fromRow;
      if (r < 0 || r >= ids.length || String(ids[r]) !== String(this.rows[i][this.id])) { ok = false; break; }
    }
    if (ok) {
      // нові рядки, додані людиною (Відповіді) — підхоплюємо
      let present = 0;
      for (let i = 0; i < ids.length; i++) if (ids[i] !== '' && ids[i] !== null) present++;
      if (present !== this.rows.length) ok = false;
    }
    if (!ok) this.load(this.fromRow);
  }

  _fullRowValues(o) {
    this.keys();
    const arr = new Array(this._keys.length);
    for (let i = 0; i < arr.length; i++) arr[i] = '';
    this.schema.columns.forEach(function (c) {
      arr[this._colIndex[c.key] - 1] = toCell_(c, o[c.key]);
    }, this);
    return arr;
  }

  /** Додає рядки в кінець. Повертає створені об'єкти. */
  appendMany(objs) {
    if (!objs.length) return [];
    this.ensureLoaded();
    this.verifyFresh();
    const sh = this.sheet();
    const start = this.lastDataRow() + 1;
    ensureCapacity_(this, start + objs.length - 1);
    const width = this._keys.length;
    const values = objs.map(function (o) { return this._fullRowValues(o); }, this);
    sh.getRange(start, 1, objs.length, width).setValues(values);
    const created = [];
    for (let i = 0; i < objs.length; i++) {
      const o = { _row: start + i };
      this.schema.columns.forEach(function (c) { o[c.key] = (objs[i][c.key] === undefined) ? null : objs[i][c.key]; });
      this.rows.push(o);
      if (this.id) this.byId[o[this.id]] = o;
      created.push(o);
    }
    return created;
  }
  append(obj) { return this.appendMany([obj])[0]; }

  /** Оновлює лише змінені клітинки (не перезаписує чужих правок у інших колонках). */
  update(rowObj, patch, opts) {
    this.verifyFresh();
    const target = (this.id && this.byId[rowObj[this.id]]) ? this.byId[rowObj[this.id]] : rowObj;
    const sh = this.sheet();
    const changed = [];
    Object.keys(patch).forEach(function (k) {
      const c = this.col(k);
      const nv = patch[k] === undefined ? null : patch[k];
      if (!sameValue_(target[k], nv)) changed.push({ idx: this.colIdx(k), col: c, val: nv });
    }, this);
    if (!changed.length) return target;
    changed.sort(function (a, b) { return a.idx - b.idx; });
    if (opts && opts.atomic) {
      // Одна операція запису: від першої до останньої зміненої колонки. Проміжні клітинки
      // беремо з аркуша як є (щоб не затирати правки команди) — зміни рядка або є всі, або немає жодної.
      const first = changed[0].idx, last = changed[changed.length - 1].idx;
      const cur = sh.getRange(target._row, first, 1, last - first + 1).getValues()[0];
      changed.forEach(function (r) { cur[r.idx - first] = toCell_(r.col, r.val); });
      sh.getRange(target._row, first, 1, last - first + 1).setValues([cur]);
      changed.forEach(function (ch) { target[ch.col.key] = ch.val; });
      return target;
    }
    // групуємо в суміжні відрізки
    let i = 0;
    while (i < changed.length) {
      let j = i;
      while (j + 1 < changed.length && changed[j + 1].idx === changed[j].idx + 1) j++;
      const run = changed.slice(i, j + 1);
      sh.getRange(target._row, run[0].idx, 1, run.length).setValues([run.map(function (r) { return toCell_(r.col, r.val); })]);
      i = j + 1;
    }
    changed.forEach(function (ch) { target[ch.col.key] = ch.val; });
    return target;
  }

  /** Видаляє рядки за умовою; повертає кількість. Завжди читає повну таблицю. */
  deleteWhere(fn) {
    this.load(3);
    const rowsToDel = this.rows.filter(fn).map(function (r) { return r._row; }).sort(function (a, b) { return a - b; });
    if (!rowsToDel.length) return 0;
    const sh = this.sheet();
    // групи суміжних рядків, видаляємо знизу догори
    const groups = [];
    rowsToDel.forEach(function (r) {
      const g = groups[groups.length - 1];
      if (g && r === g.start + g.count) g.count++; else groups.push({ start: r, count: 1 });
    });
    for (let i = groups.length - 1; i >= 0; i--) sh.deleteRows(groups[i].start, groups[i].count);
    this.load(3);
    return rowsToDel.length;
  }
}

function sameValue_(a, b) {
  if (a === null || a === undefined) a = null;
  if (b === null || b === undefined) b = null;
  if (a === null || b === null) return a === b;
  if (typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b || String(a) === String(b);
}

function openSpreadsheet_() {
  const c = G();
  if (!c.ss) {
    const id = propGet_(PROP.SPREADSHEET_ID);
    if (!id) throw new SafeError('no_spreadsheet', 'Не задано SPREADSHEET_ID. Запустіть bootstrap_().');
    c.ss = SpreadsheetApp.openById(id);
  }
  return c.ss;
}

function table_(schemaKey) {
  const c = G();
  if (!c.tables[schemaKey]) {
    const schema = SCHEMA[schemaKey];
    if (!schema) throw new SafeError('unknown_table', schemaKey);
    c.tables[schemaKey] = new Table(c, schema);
  }
  return c.tables[schemaKey];
}
SCHEMA.REPLIES.scanLast = true;
SCHEMA.REPORT.scanLast = true;
SCHEMA.GUIDE.scanLast = true;

/** Гарантує кількість рядків і застосовує формати до нової ділянки. */
function ensureCapacity_(table, needRow) {
  const sh = table.sheet();
  const max = sh.getMaxRows();
  if (needRow <= max) return;
  const add = Math.max(needRow - max, 500);
  sh.insertRowsAfter(max, add);
  applyColumnFormats_(table, max + 1, max + add);
}

/** Формати стовпців: текст '@' для текстових (захист від формул), числа, чекбокси лише для редагованих boolean. */
function applyColumnFormats_(table, fromRow, toRow) {
  const sh = table.sheet();
  const n = toRow - fromRow + 1;
  if (n <= 0) return;
  table.schema.columns.forEach(function (c) {
    const idx = table.colIdx(c.key);
    const rng = sh.getRange(fromRow, idx, n, 1);
    if (isTextLike_(c)) rng.setNumberFormat('@');
    else if (c.type === 'n') rng.setNumberFormat('0');
    if (c.type === 'b' && c.writable) rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    else if (c.enumName && c.writable) {
      rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ENUM[c.enumName], true).setAllowInvalid(false).build());
    }
  });
}

// ---------- Налаштування ----------
function parseSettingValue_(def, raw) {
  const type = def[1];
  if (type === 'n') {
    const n = Number(String(raw).replace(',', '.').replace(/\s/g, ''));
    if (raw === '' || raw === null || isNaN(n)) throw new Error('не число');
    if (def[4] !== undefined && n < def[4]) throw new Error('менше ' + def[4]);
    if (def[5] !== undefined && n > def[5]) throw new Error('більше ' + def[5]);
    return n;
  }
  if (type === 'b') {
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === 'так' || s === '1') return true;
    if (s === 'false' || s === 'ні' || s === '0') return false;
    throw new Error('очікується true/false');
  }
  if (type === 'l') return parseList_(raw);
  return String(raw === null || raw === undefined ? '' : raw).trim();
}

function settings_() {
  const c = G();
  if (c.settings) return c.settings;
  const rows = table_('SETTINGS').load(3).rows;
  const raw = {};
  rows.forEach(function (r) { if (r.kind === 'param') raw[r.key] = r.value; });
  const S = {};
  const problems = [];
  SETTINGS_DEF.forEach(function (def) {
    const key = def[0];
    let val;
    const present = raw[key] !== undefined && raw[key] !== null && raw[key] !== '';
    const src = present ? raw[key] : def[2];
    try {
      val = parseSettingValue_(def, src);
    } catch (e) {
      problems.push(key + ': ' + e.message + ' — застосовано значення за замовчуванням');
      val = parseSettingValue_(def, def[2]);
    }
    S[key] = val;
  });
  // взаємна сумісність
  if (S.DEFAULT_TRIAL_DAYS > S.MAX_TRIAL_DAYS) { problems.push('DEFAULT_TRIAL_DAYS > MAX_TRIAL_DAYS — застосовано 14/21'); S.DEFAULT_TRIAL_DAYS = 14; S.MAX_TRIAL_DAYS = 21; }
  if (parseHm_(S.QUIET_ALLOWED_START, -1) < 0 || parseHm_(S.QUIET_ALLOWED_END, -1) < 0 || parseHm_(S.QUIET_ALLOWED_START, 0) >= parseHm_(S.QUIET_ALLOWED_END, 0)) {
    problems.push('QUIET_ALLOWED_START/END некоректні — застосовано 10:00/20:00'); S.QUIET_ALLOWED_START = '10:00'; S.QUIET_ALLOWED_END = '20:00';
  }
  S.SURVEY_REMINDER_OFFSETS = S.SURVEY_REMINDER_OFFSETS.map(Number).filter(function (n) { return !isNaN(n) && n > 0; }).sort(function (a, b) { return a - b; });
  if (!S.SURVEY_REMINDER_OFFSETS.length) S.SURVEY_REMINDER_OFFSETS = [3, 6];
  if (S.SURVEY_REMINDER_OFFSETS.some(function (n) { return n >= S.FEEDBACK_WINDOW_DAYS; })) {
    problems.push('SURVEY_REMINDER_OFFSETS мають бути меншими за FEEDBACK_WINDOW_DAYS — застосовано 3,6 і 7');
    S.SURVEY_REMINDER_OFFSETS = [3, 6]; S.FEEDBACK_WINDOW_DAYS = 7;
  }
  if (!/^\d{4}-\d{2}$/.test(S.EXPECTED_RELEASE_MONTH)) { problems.push('EXPECTED_RELEASE_MONTH має формат РРРР-ММ'); S.EXPECTED_RELEASE_MONTH = '2027-02'; }
  ['APP_STORE_BASE_URL', 'PLAY_STORE_BASE_URL'].forEach(function (k) {
    const host = k === 'APP_STORE_BASE_URL' ? 'apps.apple.com' : 'play.google.com';
    if (!new RegExp('^https://' + host.replace(/\./g, '\\.') + '/').test(S[k])) {
      problems.push(k + ' має починатися з https://' + host + '/ — застосовано значення за замовчуванням');
      S[k] = SETTINGS_DEF.filter(function (d) { return d[0] === k; })[0][2];
    }
  });
  try { Utilities.formatDate(new Date(), S.TIMEZONE, 'yyyy'); } catch (e) { problems.push('TIMEZONE некоректний — застосовано Europe/Kyiv'); S.TIMEZONE = 'Europe/Kyiv'; }
  S.TEST_CHAT_ALLOWLIST = S.TEST_CHAT_ALLOWLIST.map(String);
  c.settings = S;
  c.settingsProblems = problems;
  return S;
}

/** Шаблон: значення з аркуша, якщо в ньому лише дозволені placeholders; інакше — шаблон за замовчуванням. */
function templates_() {
  const c = G();
  if (c.templates) return c.templates;
  const rows = table_('SETTINGS').load(3).rows;
  const t = {};
  rows.forEach(function (r) { if (r.kind === 'template' && r.value) t[r.key] = r.value; });
  c.templates = t;
  return t;
}
function placeholdersIn_(text) {
  const out = [];
  const re = /\{\{\s*([a-z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}
function renderTemplate_(name, values) {
  const def = TEMPLATE_DEF[name];
  if (!def) throw new SafeError('unknown_template', name);
  values = values || {};
  const candidates = [];
  const custom = templates_()[name];
  if (custom) candidates.push(custom);
  candidates.push(def.text);
  for (let i = 0; i < candidates.length; i++) {
    const text = candidates[i];
    const used = placeholdersIn_(text);
    const bad = used.filter(function (p) { return def.placeholders.indexOf(p) < 0; });
    const missing = used.filter(function (p) { return values[p] === undefined || values[p] === null; });
    if (bad.length || missing.length) {
      if (i === 0 && custom) {
        reportIncident_('templates', 'template_invalid', 'Шаблон "' + name + '" у таблиці пошкоджений (недозволені або порожні placeholders); використано шаблон за замовчуванням.', { level: 'warn', entityType: 'template', entityId: name });
      }
      continue;
    }
    return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, function (m0, p) { return String(values[p]); });
  }
  throw new SafeError('template_unrenderable', 'Шаблон ' + name + ' не вдалося підставити.');
}

// ---------- Журнал інцидентів ----------
/**
 * Створює/оновлює інцидент у "Техжурнал". Дедуплікація: component+code+entityId (відкриті).
 * opts: {level, entityType, entityId, notify}
 * Сповіщення власнику лише при notify=true і один раз на інцидент.
 */
function reportIncident_(component, code, summary, opts) {
  opts = opts || {};
  try {
    const tbl = table_('TECHLOG');
    const last = tbl.lastDataRow();
    if (!tbl._incidentWindowLoaded) { tbl.load(Math.max(3, last - 499)); tbl._incidentWindowLoaded = true; }
    const entityId = toText_(opts.entityId);
    const existing = tbl.find(function (r) {
      return r.component === component && r.error_code === code && toText_(r.related_entity_id) === entityId && r.state !== 'closed';
    });
    const nowIso = nowIso_();
    let inc;
    if (existing) {
      inc = tbl.update(existing, { occurrences: (existing.occurrences || 1) + 1, last_seen_at: nowIso, state: existing.state === 'recovered' ? 'open' : existing.state });
    } else {
      inc = tbl.append({
        incident_id: 'inc_' + Utilities.getUuid().replace(/-/g, '').slice(0, 12),
        correlation_id: G().correlationId,
        created_at: nowIso, level: opts.level || 'error', component: component, error_code: code,
        safe_summary: trunc_(scrub_(summary), 400), related_entity_type: opts.entityType || null,
        related_entity_id: entityId || null, state: 'open', last_seen_at: nowIso, occurrences: 1,
        owner_alert_status: 'none', closed_at: null
      });
    }
    if (opts.notify && (!inc.owner_alert_status || inc.owner_alert_status === 'none')) {
      const ownerChat = propGet_(PROP.OWNER_CHAT_ID);
      if (ownerChat) {
        const text = '🛠 СИСТЕМА (технічне)\n' + renderTemplate_('owner_incident', { component: component, code: code, summary: trunc_(scrub_(summary), 300), incident_id: inc.incident_id });
        enqueueOutbox_({
          idempotencyKey: 'incident:' + inc.incident_id + ':alert', participantId: null, recipientChatId: ownerChat,
          kind: 'owner_incident', payload: { method: 'sendMessage', text: text }, priority: PRIORITY.OWNER_ALERT
        });
        tbl.update(inc, { owner_alert_status: 'queued' });
      }
    }
    return inc;
  } catch (e) {
    // журнал не повинен ламати основний процес
    try { Logger.log('incident_write_failed: ' + scrub_(e && e.message)); } catch (e2) { /* ignore */ }
    return null;
  }
}
function recoverIncident_(component, code, entityId) {
  try {
    const tbl = table_('TECHLOG');
    const last = tbl.lastDataRow();
    if (!tbl._incidentWindowLoaded) { tbl.load(Math.max(3, last - 499)); tbl._incidentWindowLoaded = true; }
    const ex = tbl.find(function (r) { return r.component === component && r.error_code === code && toText_(r.related_entity_id) === toText_(entityId) && r.state === 'open'; });
    if (ex) tbl.update(ex, { state: 'recovered', last_seen_at: nowIso_() });
  } catch (e) { /* ignore */ }
}
