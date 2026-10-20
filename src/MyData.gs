/**
 * MyData.gs — «Участь і дані» → «Переглянути мої дані».
 * Учасник бачить у чаті те, що бот зберігає про нього в таблиці: профіль, участь, згоду, звернення, свої повідомлення,
 * відповіді анкети, подяку. Лише читання. Нічого не змінюється й не надсилається нікому, крім самого учасника.
 *
 * Не показуємо: службові примітки команди (internal_notes, analyst_note, evidence_label), технічні ідентифікатори файлів і посилання перегляду.
 * Це сказано в тексті внизу, щоб учасник знав, як їх запросити.
 */

const MYDATA_MAX_TICKETS = 10;
const MYDATA_MAX_MESSAGES = 15;
const MYDATA_MAX_ANSWERS = 30;
const MYDATA_SNIPPET = 160;

function mdVal_(v, empty) {
  if (v === null || v === undefined || v === '') return empty || '—';
  if (v === true) return 'так';
  if (v === false) return 'ні';
  return String(v);
}
function mdDate_(iso, tz) {
  const ms = parseIso_(iso);
  return ms === null ? '—' : localDateTimeStr_(ms, tz);
}
function mdOne_(s, n) {
  return trunc_(toText_(s).replace(/\s+/g, ' ').trim(), n || MYDATA_SNIPPET);
}

const MD_PLATFORM = { android: 'Android', ios: 'iPhone/iPad', both: 'обидва' };
const MD_ROLE = { author: 'автор', viewer: 'глядач', both: 'автор і глядач' };
const MD_STATUS = {
  onboarding: 'реєстрація', waiting_capacity: 'у черзі', active: 'тестує', awaiting_feedback: 'очікуємо фідбек',
  finished: 'завершено', withdrawn: 'вийшов(-ла)'
};
const MD_CONTACT = { reachable: 'повідомлення увімкнено', blocked: 'бот заблокований', opted_out: 'повідомлення вимкнено' };
const MD_TICKET = { new: 'нове', in_progress: 'у роботі', waiting_user: 'чекаємо тебе', resolved: 'вирішено' };
const MD_REWARD = {
  premium_month: 'місяць преміуму', research_results: 'результати тестування', public_thanks: 'публічна подяка'
};
const MD_REWARD_STATUS = {
  eligible_unselected: 'право є, вибір не зроблено', pending_release: 'очікує релізу', pending_fulfillment: 'готуємо видачу',
  fulfilled: 'виконано', cancelled_by_user: 'скасовано тобою'
};

/** Збирає текст «моїх даних» для учасника p. Повертає рядок (може бути довгим: чат розіб'є на частини). */
function buildMyDataText_(p, S) {
  const tz = S.TIMEZONE;
  const out = [];
  out.push(renderTemplate_('my_data_head'));

  out.push('\nПРОФІЛЬ (з Telegram)');
  out.push('Ім\'я: ' + mdVal_([p.first_name, p.last_name].filter(function (x) { return x; }).join(' ')));
  out.push('Username: ' + (p.username ? '@' + p.username : '—'));
  out.push('Telegram ID: ' + mdVal_(p.telegram_user_id));
  out.push('Мова Telegram: ' + mdVal_(p.language_code));

  out.push('\nУЧАСТЬ');
  out.push('Статус: ' + mdVal_(MD_STATUS[p.participation_status] || p.participation_status));
  out.push('Платформа: ' + mdVal_(MD_PLATFORM[p.platform] || p.platform));
  out.push('Роль (за твоїм вибором): ' + mdVal_(MD_ROLE[p.declared_role] || p.declared_role));
  out.push('Згода (версія ' + mdVal_(p.consent_version) + '): ' + mdDate_(p.consent_at, tz));
  out.push('Початок тесту: ' + mdDate_(p.trial_started_at, tz) + '. Кінець: ' + mdDate_(p.trial_end_at, tz) + '.');
  out.push('Продовження використано: ' + mdVal_(p.extension_used === true ? true : false));
  out.push('Повідомлення від бота: ' + mdVal_(MD_CONTACT[p.contact_status] || p.contact_status));
  out.push('Зареєстровано: ' + mdDate_(p.created_at, tz));

  // Звернення
  const tickets = tickets_().filter(function (t) { return t.participant_id === p.participant_id; })
    .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  out.push('\nЗВЕРНЕННЯ: ' + tickets.length);
  tickets.slice(0, MYDATA_MAX_TICKETS).forEach(function (tk) {
    out.push('• ' + tk.ticket_id + ' від ' + mdDate_(tk.created_at, tz) + ', ' + (MD_TICKET[tk.status] || mdVal_(tk.status)) +
      (tk.critical_by_user === true ? ', КРИТИЧНЕ' : '') + (tk.subject_or_preview ? ': ' + mdOne_(tk.subject_or_preview, 100) : ''));
  });
  if (tickets.length > MYDATA_MAX_TICKETS) out.push('… і ще ' + (tickets.length - MYDATA_MAX_TICKETS) + '. Повний список є в команди.');

  // Повідомлення учасника
  const msgs = messages_().filter(function (m) { return m.participant_id === p.participant_id && m.author_type === 'participant'; })
    .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  out.push('\nТВОЇ ПОВІДОМЛЕННЯ, збережені в таблиці: ' + msgs.length);
  msgs.slice(0, MYDATA_MAX_MESSAGES).forEach(function (m) {
    out.push('• ' + mdDate_(m.created_at, tz) + ': ' + (m.body_text ? mdOne_(m.body_text) : '(без тексту, лише файл)'));
  });
  if (msgs.length > MYDATA_MAX_MESSAGES) out.push('… показано останні ' + MYDATA_MAX_MESSAGES + ' з ' + msgs.length + '.');

  // Вкладення
  const atts = table_('ATTACHMENTS').filter(function (a) { return a.participant_id === p.participant_id; });
  const byType = {};
  atts.forEach(function (a) { byType[a.media_type || 'файл'] = (byType[a.media_type || 'файл'] || 0) + 1; });
  out.push('\nФАЙЛИ, які ти надсилав(-ла): ' + atts.length + (atts.length ? ' (' + Object.keys(byType).map(function (k) { return k + ': ' + byType[k]; }).join(', ') + ')' : ''));

  // Анкета
  const sv = surveys_().find(function (s) { return s.participant_id === p.participant_id; });
  const answers = sv ? answers_().filter(function (a) { return a.participant_id === p.participant_id && a.is_current === true; }) : [];
  out.push('\nАНКЕТА: ' + (sv ? ({ not_started: 'не розпочато', in_progress: 'триває', paused: 'на паузі', completed: 'завершено', collection_closed: 'збір завершено' }[sv.status] || sv.status) : 'не розпочато'));
  answers.sort(function (a, b) { return String(a.answered_at).localeCompare(String(b.answered_at)); }).slice(0, MYDATA_MAX_ANSWERS).forEach(function (a) {
    let shown;
    if (a.answer_format === 'skipped') shown = '(пропущено)';
    else shown = a.answer_text ? mdOne_(a.answer_text) : mdOne_(a.answer_enum_or_json, 100);
    out.push('• ' + a.question_id + ': ' + shown + (a.attachment_ids ? ' [+ файли]' : ''));
  });
  if (answers.length > MYDATA_MAX_ANSWERS) out.push('… показано перші ' + MYDATA_MAX_ANSWERS + ' з ' + answers.length + '.');

  // Подяка
  const rw = rewards_().find(function (r) { return r.participant_id === p.participant_id; });
  out.push('\nПОДЯКА');
  if (!rw) out.push('Права на подяку поки немає (воно з\'являється після фідбеку).');
  else {
    out.push('Статус: ' + (MD_REWARD_STATUS[rw.status] || mdVal_(rw.status)));
    out.push('Обрано: ' + mdVal_(MD_REWARD[rw.reward_choice] || rw.reward_choice, 'ще не обрано'));
    if (rw.email) out.push('Email для подяки: ' + rw.email);
    out.push('Дозвіл писати про подяку: ' + mdVal_(rw.contact_allowed === true ? true : (rw.contact_allowed === false ? false : null)));
    if (rw.public_display_name) out.push('Ім\'я для публікації: ' + rw.public_display_name + (rw.publication_consent_at ? ' (згода від ' + mdDate_(rw.publication_consent_at, tz) + ')' : ''));
    if (rw.public_profile_url) out.push('Посилання для публікації: ' + rw.public_profile_url);
  }

  out.push('\n' + renderTemplate_('my_data_foot'));
  return out.join('\n');
}

/** Обробник кнопки (хід учасника). Лише читання; відповідь іде в Outbox як звичайне повідомлення. */
function onMenuMyData_(t) {
  t.say('my_data', buildMyDataText_(t.p, t.S), dataMenuKb_(t));
  return true;
}
