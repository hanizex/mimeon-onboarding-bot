/**
 * Config.gs — константи, enum, схеми аркушів, початкові налаштування, шаблони.
 * Усі файли проєкту ділять глобальну область видимості Apps Script (V8).
 * Порядок завантаження: Config.gs має йти першим (у Apps Script — перший у списку файлів).
 */

const APP_VERSION = '1.5.1';
const SCHEMA_VERSION = 8;

// ---------- Ключі Script Properties (секрети й службовий стан; НЕ в таблиці) ----------
const PROP = {
  BOT_TOKEN: 'BOT_TOKEN',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  OWNER_TELEGRAM_USER_ID: 'OWNER_TELEGRAM_USER_ID',
  OWNER_CHAT_ID: 'OWNER_CHAT_ID',
  VIEWER_SIGNING_SECRET: 'VIEWER_SIGNING_SECRET',
  SETUP_BIND_HASH: 'SETUP_BIND_HASH',          // SHA-256 від одноразового коду (сам код не зберігається)
  SETUP_BIND_EXPIRES: 'SETUP_BIND_EXPIRES',    // ISO UTC
  SETUP_MODE: 'SETUP_MODE',                    // 'true' | відсутній
  TELEGRAM_NEXT_OFFSET: 'TELEGRAM_NEXT_OFFSET',
  SCHEMA_VERSION: 'schema_version',
  BOT_ID: 'BOT_ID',
  LAST_TICK_AT: 'LAST_TICK_AT',
  LAST_TICK_JSON: 'LAST_TICK_JSON',
  WM_INBOX: 'WM_INBOX',                        // рядок, нижче якого всі події фінальні
  WM_OUTBOX: 'WM_OUTBOX',
  CONFIRM_DELETE_WEBHOOK: 'CONFIRM_DELETE_WEBHOOK', // 'yes' — власник свідомо дозволив відключити webhook
  ALLOW_ADMIN_LAUNCHERS: 'ALLOW_ADMIN_LAUNCHERS',   // 'true' вмикає публічні обгортки Launcher.gs
  SUPPORT_HK_AT: 'SUPPORT_HK_AT',                   // коли востаннє виконано обслуговування звернень (SLA-позначки)
  VIEWER_HK_AT: 'VIEWER_HK_AT',                     // коли востаннє оновлено посилання перегляду вкладень
  OVERVIEW_AT: 'OVERVIEW_AT',                       // коли востаннє перерахований лист "Огляд"
  OVERVIEW_HASH: 'OVERVIEW_HASH',                   // контрольна сума останнього запису "Огляду" (щоб не переписувати незмінене)
  REWARD_HK_AT: 'REWARD_HK_AT',                     // коли востаннє виконано обслуговування винагород
  ACK_PENDING: 'ACK_PENDING',                       // підтвердження «Обробляю…», що чекають на видалення (JSON)
  LAST_ACTIVITY_AT: 'LAST_ACTIVITY_AT',             // коли востаннє надійшло повідомлення від учасника (для режиму швидкої відповіді)
  FAST_USED: 'FAST_USED',                           // {d: дата, s: секунд режиму швидкої відповіді за добу}
  RUN_USED: 'RUN_USED',                             // {d: дата, s: секунд роботи ВСІХ запусків за добу (оцінка квоти тригерів Google)}
  QUOTA_GUARD_DAY: 'QUOTA_GUARD_DAY',               // дата, коли запобіжник квоти вже спрацював і про це повідомлено власнику
  LIVE_UNTIL: 'LIVE_UNTIL'                          // ISO: до коли бот слухає Telegram безперервно (команда власника /live)
};

// ---------- Аркуші ----------
const SHEET = {
  START: 'START', OVERVIEW: 'OVERVIEW', PARTICIPANTS: 'PARTICIPANTS', TICKETS: 'TICKETS',
  MESSAGES: 'MESSAGES', REPLIES: 'REPLIES', ATTACHMENTS: 'ATTACHMENTS', SURVEYS: 'SURVEYS',
  ANSWERS: 'ANSWERS', REWARDS: 'REWARDS', STORE_METRICS: 'STORE_METRICS', REPORT: 'REPORT',
  SETTINGS: 'SETTINGS', INBOX: 'INBOX', OUTBOX: 'OUTBOX', TECHLOG: 'TECHLOG', GUIDE: 'GUIDE'
};

// ---------- Enum ----------
const ENUM = {
  participation: ['onboarding', 'waiting_capacity', 'active', 'awaiting_feedback', 'finished', 'withdrawn'],
  survey: ['not_started', 'in_progress', 'paused', 'completed', 'collection_closed'],
  contact: ['reachable', 'blocked', 'opted_out'],
  dialog: ['none', 'onboarding_platform', 'onboarding_role', 'support_body', 'support_details', 'support_choose', 'survey_question',
    'reward_choice', 'reward_email', 'reward_public_name', 'delete_confirmation', 'guide'],
  reward: ['not_eligible', 'eligible_unselected', 'pending_release', 'pending_fulfillment', 'fulfilled', 'cancelled_by_user'],
  ticket: ['new', 'in_progress', 'waiting_user', 'resolved', 'closed'],
  platform: ['android', 'ios', 'both'],
  role: ['author', 'viewer', 'both'],
  outbox: ['queued', 'sending', 'sent', 'retry_wait', 'failed', 'delivery_unknown', 'cancelled'],
  operatorAction: ['none', 'retry_verified', 'mark_delivered_verified', 'cancel'],
  inbox: ['pending', 'processed', 'duplicate', 'ignored', 'manual_review', 'held', 'part'],
  direction: ['in', 'out'],
  authorType: ['participant', 'team', 'bot'],
  branch: ['not_started_experience', 'one_day', 'multiple_days', 'unknown_experience'],
  evidence: ['unreviewed', 'factual_selfreport', 'opinion', 'unclear'],
  availability: ['available', 'delayed', 'privacy_suppressed', 'not_configured', 'unavailable'],
  incident: ['open', 'recovered', 'closed'],
  level: ['info', 'warn', 'error', 'critical'],
  replyDelivery: ['draft', 'queued', 'sent', 'failed', 'delivery_unknown', 'cancelled'],
  alertStatus: ['none', 'queued', 'sent', 'failed', 'delivery_unknown'],
  accountMatch: ['unknown', 'matched', 'needs_account_match', 'not_found']
};

// ---------- Компактна специфікація колонок ----------
// рядок: key|Мітка (укр.)|Пояснення (укр.)|прапорці
// прапорці: t=текст, d=дата-час ISO UTC (текст), n=число, b=boolean (true/false/порожньо=null), j=JSON-текст,
//           e:NAME=enum, w=дозволено редагувати команді (інакше захищено)
const COLUMN_SPEC = {
  PARTICIPANTS: `
participant_id|ID учасника|Внутрішній випадковий код. Це ключ запису: не змінюйте.|t
program_id|Програма|Код програми (PROGRAM_ID).|t
telegram_user_id|Telegram ID|Числовий ID користувача як текст. Username не є ключем.|t
chat_id|Chat ID|ID приватного чату як текст.|t
first_name|Ім'я (Telegram)|Лише факт з Telegram. Може бути порожнім.|t
last_name|Прізвище (Telegram)|Може бути порожнім.|t
username|Username|Може змінюватися або бути відсутнім.|t
language_code|Мова Telegram|Не використовується для визначення країни.|t
telegram_is_premium|Telegram Premium|Це не Mimeon Premium.|b
created_at|Створено (UTC)|ISO 8601 UTC.|d
last_seen_at|Остання активність (UTC)|Остання подія від учасника.|d
consent_version|Версія згоди|Версія тексту згоди.|t
consent_at|Згода (UTC)|Момент підтвердження "мені є 16 років".|d
age_16_confirmed|16+ підтверджено|Самозвіт.|b
platform|Платформа|Самозвіт: android / ios / both.|e:platform
declared_role|Роль (заявлена)|Самозвіт, не факт дії: author / viewer / both.|e:role
campaign_code|Код кампанії|Спільний код запрошень для магазинів.|t
store_link_urls_json|Посилання магазинів (JSON)|Надіслані посилання.|j
ios_link_tagged|iOS-посилання з тегом|false, якщо немає provider token.|b
android_link_tagged|Android-посилання з UTM|true, якщо додано UTM.|b
enrollment_slot_reserved|Місце зарезервоване|Враховується, лише якщо MAX_PARTICIPANTS більше 0.|b
participation_status|Статус участі|onboarding / waiting_capacity / active / awaiting_feedback / finished / withdrawn.|e:participation
trial_started_at|Початок тесту (UTC)|Ставиться один раз після УСПІШНОЇ доставки посилання. Не дата встановлення.|d
trial_end_at|Кінець тесту (UTC)|Початково +14 календарних днів (Київ).|d
trial_max_end_at|Максимум (UTC)|+21 календарний день від початку.|d
extension_used|Продовження використано|"Ще тиждень" доступне один раз.|b
contact_status|Доступність чату|reachable / blocked / opted_out.|e:contact
reminders_enabled|Нагадування увімкнені|false — учасник вимкнув нагадування про анкету.|b
reward_contact_allowed|Згода на контакт щодо винагороди|Окрема згода.|b
blocked_at|Заблокував бота (UTC)|Дані НЕ видаляються.|d
feedback_received|Фідбек отримано|Незалежний Boolean.|b
first_feedback_at|Перший фідбек (UTC)||d
latest_feedback_at|Останній фідбек (UTC)||d
active_survey_id|Активна анкета|Посилання на аркуш "Опитування".|t
schedule_version|Версія розкладу|Збільшується при продовженні та розблокуванні.|n
day5_sent_at|День 5 надіслано (UTC)||d
survey_invite_sent_at|Запрошення до анкети надіслано (UTC)|Фактична доставка.|d
survey_reminders_sent|Нагадувань про анкету надіслано|Максимум 2 сумарно.|n
feedback_collection_deadline|Кінець збору фідбеку (UTC)|7 календарних днів після доставленого запрошення.|d
dialog_type|Діалог|Поточний незавершений контекст.|e:dialog
dialog_ref_id|Діалог: ID об'єкта|Службове.|t
dialog_context_json|Діалог: контекст (JSON)|Службове.|j
internal_notes|Внутрішні примітки|Бачить лише команда. Можна редагувати.|t,w
last_event_id|Остання застосована подія|Службове: захист від повторного застосування події.|t
opted_out_at|Вимкнув повідомлення (UTC)||d
declined_at|Відмовився приєднатися (UTC)||d
is_test_record|Тестовий запис|true — не входить у метрики.|b
counted_reminder_jobs|Враховані нагадування|Службове: ID завдань нагадувань, які вже враховано в лічильнику.|t
funnel_stage|Етап воронки|Автоматично (оновлюється раз на кілька хвилин). Використовуйте фільтр за цією колонкою.|t
funnel_note|Що далі|Автоматично: найближча подія або чого очікуємо від учасника.|t
`,
  TICKETS: `
ticket_id|ID звернення|Сталий ключ.|t
participant_id|ID учасника||t
created_at|Створено (UTC)||d
critical_by_user|КРИТИЧНЕ (вибір учасника)|Лише явний вибір учасника.|b
critical_marked_at|Позначено критичним (UTC)||d
status|Статус|new / in_progress / waiting_user / resolved / closed.|e:ticket,w
subject_or_preview|Тема / початок тексту||t
assigned_to|Відповідальний|Хто відповідає.|t,w
first_team_reply_at|Перша відповідь команди (UTC)||d
last_activity_at|Остання активність (UTC)||d
waiting_since|Очікує з (UTC)||d
sla_due_at|Орієнтир відповіді до (UTC)|72 години від створення.|d
sla_overdue|Прострочено орієнтир|Не робить звернення критичним.|b
internal_notes|Внутрішні примітки|Не надсилаються учаснику.|t,w
critical_alert_status|Статус критичного сповіщення||e:alertStatus
critical_alert_message_id|Telegram message_id сповіщення||t
`,
  MESSAGES: `
message_record_id|ID запису|Сталий ключ.|t
participant_id|ID учасника||t
ticket_id|ID звернення||t
survey_id|ID анкети||t
direction|Напрям|in / out.|e:direction
author_type|Автор|participant / team / bot.|e:authorType
source_update_id|Update ID||t
telegram_message_id|Telegram message_id||t
reply_to_message_id|Відповідь на message_id||t
created_at|Час (UTC)||d
body_text|Текст||t
attachment_ids|ID вкладень||t
media_group_id|ID альбому||t
related_reply_id|ID відповіді команди||t
`,
  REPLIES: `
reply_id|ID відповіді|Призначається до snapshot. Автозаповнення.|t
ticket_id|ID звернення|Вставте ticket_id зі "Звернення".|t,w
prepared_by|Автор відповіді|Хто підготував.|t,w
prepared_at|Підготовлено (UTC)||d
response_text|Текст для учасника|Єдиний текст, який буде надіслано.|t,w
attachment_ids|ID вкладень|Лише вкладення цього ж учасника.|t,w
send_requested|Надіслати|Поставте галочку, коли відповідь готова.|b,w
snapshot_created_at|Зафіксовано (UTC)|Після цього зміни не впливають на надіслане.|d
delivery_status|Статус доставки||e:replyDelivery
sent_at|Надіслано (UTC)||d
telegram_message_id|Telegram message_id||t
error_code|Код помилки||t
error_note|Пояснення помилки||t
`,
  ATTACHMENTS: `
attachment_id|ID вкладення|Сталий ключ.|t
participant_id|ID учасника||t
message_record_id|ID повідомлення||t
ticket_id|ID звернення||t
survey_id|ID анкети||t
file_id|Telegram file_id|Не відкриває файл людині. Використовуйте посилання перегляду.|t
file_unique_id|Telegram file_unique_id||t
media_type|Тип||t
mime_type|MIME||t
file_name|Назва файлу||t
file_size_bytes|Розмір (байт)||n
caption|Підпис||t
media_group_id|ID альбому||t
viewer_token_version|Версія токена перегляду||n
viewer_url|Посилання перегляду (конфіденційне)|Для команди. Не публікувати.|t
viewer_expires_at|Посилання діє до (UTC)|Оновлюється автоматично.|d
preview_status|Статус перегляду||t
`,
  SURVEYS: `
survey_id|ID анкети|Сталий ключ.|t
participant_id|ID учасника||t
survey_version|Версія анкети||t
status|Статус|not_started / in_progress / paused / completed / collection_closed.|e:survey
branch|Гілка||e:branch
current_question_id|Поточне питання||t
current_prompt_message_id|message_id поточного питання||t
started_at|Початок (UTC)||d
last_answer_at|Остання відповідь (UTC)||d
completed_at|Завершено (UTC)||d
last_period_start|Період: початок (UTC)||d
last_period_end|Період: кінець (UTC)||d
branch_revision|Ревізія гілки||n
paused_by_support|Призупинено критичним зверненням||b
analyst_notes|Примітки аналітика||t,w
`,
  ANSWERS: `
answer_id|ID відповіді|Сталий ключ.|t
survey_id|ID анкети||t
participant_id|ID учасника||t
question_id|ID питання||t
survey_version|Версія анкети||t
question_text_snapshot|Текст питання (знімок)||t
answer_format|Формат||t
answer_enum_or_json|Відповідь (enum/JSON)||j
answer_text|Відповідь (текст)|Дослівно.|t
attachment_ids|ID вкладень||t
answered_at|Час (UTC)||d
source_update_id|Update ID||t
telegram_message_id|Telegram message_id||t
answer_revision|Ревізія||n
is_current|Актуальна||b
applies_to_current_branch|Для поточної гілки||b
evidence_label|Мітка доказовості|unreviewed / factual_selfreport / opinion / unclear. Редагує аналітик.|e:evidence,w
analyst_note|Примітка аналітика||t,w
`,
  REWARDS: `
reward_id|ID винагороди|Сталий ключ.|t
participant_id|ID учасника||t
eligible_at|Право з (UTC)||d
eligibility_source_type|Джерело права||t
eligibility_source_id|ID джерела права||t
reward_choice|Вибір|premium_month / research_results / public_thanks.|t
choice_at|Час вибору (UTC)||d
contact_allowed|Згода на контакт||b
email|Email (лише для преміуму)|Ніколи не публікується.|t
account_match_status|Збіг акаунта||e:accountMatch,w
public_display_name|Ім'я для публікації||t
public_profile_url|Посилання (необов'язково)||t
publication_consent_at|Згода на публікацію (UTC)||d
public_entry_id|ID запису на сайті|Для відкликання без Telegram ID.|t,w
status|Статус|not_eligible / eligible_unselected / pending_release / pending_fulfillment / fulfilled / cancelled_by_user.|e:reward,w
fulfilled_at|Виконано (UTC)||d,w
premium_activated_at|Преміум активовано (UTC)||d,w
premium_expires_at|Преміум діє до (UTC)||d,w
report_version|Версія звіту||t,w
public_thanks_url|URL публічної подяки||t,w
notification_status|Статус повідомлення про виконання||t
internal_notes|Внутрішні примітки||t,w
`,
  STORE_METRICS: `
snapshot_id|ID зрізу|Сталий ключ (можна вигадати: platform-metric-period).|t,w
platform|Платформа|android / ios.|t,w
app_id_or_package|App ID / package||t,w
campaign_code|Код кампанії||t,w
metric_name|Точна назва метрики|Скопіюйте з консолі магазину.|t,w
unit|Одиниця||t,w
period_from|Період з (дата)||t,w
period_to|Період до (дата)||t,w
source_timezone|Часовий пояс джерела||t,w
value|Значення|Порожнє = невідомо, НЕ нуль.|t,w
filters|Фільтри||t,w
retrieved_at|Дата отримання||t,w
source_description|Опис джерела||t,w
availability|Доступність|available / delayed / privacy_suppressed / not_configured / unavailable.|e:availability,w
`,
  REPORT: `
block_id|ID блоку|Сталий ключ.|t,w
order|Порядок||n,w
section|Розділ||t,w
text|Текст блоку|Лише знеособлені дані.|t,w
approved|Затверджено||b,w
report_version|Версія звіту||t,w
`,
  GUIDE: `
page_id|ID сторінки|Сталий ключ (наприклад g1). Не змінюйте після запуску.|t,w
order|Порядок|Число: 1, 2, 3… Так сторінки йдуть у меню гайда.|n,w
title|Назва (на кнопці)|Коротко, до 14 символів: це підпис кнопки.|t,w
text|Текст сторінки|Що побачить учасник. До 3500 символів.|t,w
image_url|Скріншот (https-посилання)|Пряме https-посилання на зображення (jpg/png). Порожньо — без картинки.|t,w
enabled|Показувати|Галочка = сторінку видно в гайді. Нову сторінку не забудьте позначити.|b,w
`,
  SETTINGS: `
kind|Тип|param / template / faq.|t
key|Ключ||t
value|Значення|Змінюйте лише цю колонку.|t,w
description|Пояснення||t
`,
  INBOX: `
event_id|ID події|bot_id:update_id.|t
bot_id|Bot ID||t
update_id|Update ID||t
event_type|Тип події||t
telegram_user_id|Telegram ID||t
chat_id|Chat ID||t
received_at|Отримано (UTC)||d
payload_json|Нормалізований payload||j
payload_parts_count|Частин payload||n
payload_checksum|Контрольна сума||t
status|Статус||e:inbox
attempt_count|Спроб||n
next_attempt_at|Наступна спроба (UTC)||d
processed_at|Оброблено (UTC)||d
error_code|Код помилки||t
error_note|Пояснення||t
business_key|Бізнес-ключ|chat_id:message_id:(new|edit N).|t
`,
  OUTBOX: `
job_id|ID завдання||t
idempotency_key|Ключ ідемпотентності||t
participant_id|ID учасника||t
ticket_id|ID звернення||t
reply_id|ID відповіді||t
recipient_chat_id|Chat ID одержувача||t
message_kind|Тип повідомлення||t
payload_json|Payload||j
priority|Пріоритет|1 — найвищий.|n
schedule_version|Версія розкладу||n
created_at|Створено (UTC)||d
due_at|Не раніше (UTC)||d
status|Статус||e:outbox
attempt_count|Спроб||n
next_attempt_at|Наступна спроба (UTC)||d
started_at|Початок відправки (UTC)||d
sent_at|Надіслано (UTC)||d
telegram_message_id|Telegram message_id||t
last_error_code|Код помилки||t
last_error_note|Що сталося і що робити||t
operator_action|Дія оператора|none / retry_verified (перевірено — повторити) / mark_delivered_verified (перевірено — доставлено) / cancel.|e:operatorAction,w
post_sent_done|Післядія виконана||b
`,
  TECHLOG: `
incident_id|ID інциденту||t
correlation_id|Correlation ID||t
created_at|Створено (UTC)||d
level|Рівень||e:level
component|Компонент||t
error_code|Код||t
safe_summary|Безпечний опис|Без токенів і приватних текстів.|t
related_entity_type|Тип об'єкта||t
related_entity_id|ID об'єкта||t
state|Стан|open / recovered / closed. Закрийте після усунення.|e:incident,w
last_seen_at|Востаннє (UTC)||d
occurrences|Повторень||n
owner_alert_status|Сповіщення власнику||e:alertStatus
closed_at|Закрито (UTC)||d
`
};

// Параметри таблиць: назва в Sheets (українська), ключ ідентифікатора, тип
const SHEET_DEF = {
  START: { name: 'Старт', kind: 'doc' },
  OVERVIEW: { name: 'Огляд', kind: 'doc' },
  PARTICIPANTS: { name: 'Учасники', kind: 'table', id: 'participant_id' },
  TICKETS: { name: 'Звернення', kind: 'table', id: 'ticket_id' },
  MESSAGES: { name: 'Повідомлення', kind: 'table', id: 'message_record_id' },
  REPLIES: { name: 'Відповіді', kind: 'table', id: 'reply_id' },
  ATTACHMENTS: { name: 'Вкладення', kind: 'table', id: 'attachment_id' },
  SURVEYS: { name: 'Опитування', kind: 'table', id: 'survey_id' },
  ANSWERS: { name: 'Відповіді анкети', kind: 'table', id: 'answer_id' },
  REWARDS: { name: 'Винагороди', kind: 'table', id: 'reward_id' },
  STORE_METRICS: { name: 'Аналітика магазинів', kind: 'table', id: 'snapshot_id' },
  REPORT: { name: 'Звіт для учасників', kind: 'table', id: 'block_id' },
  SETTINGS: { name: 'Налаштування', kind: 'table', id: null },
  INBOX: { name: 'Вхідні', kind: 'table', id: 'event_id' },
  OUTBOX: { name: 'Вихідні', kind: 'table', id: 'job_id' },
  TECHLOG: { name: 'Техжурнал', kind: 'table', id: 'incident_id' },
  GUIDE: { name: 'Гайд', kind: 'table', id: 'page_id' }
};

// Розбір COLUMN_SPEC у структури (одноразово)
const SCHEMA = (function () {
  const out = {};
  Object.keys(COLUMN_SPEC).forEach(function (sk) {
    const cols = [];
    COLUMN_SPEC[sk].split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      const p = line.split('|');
      const flags = (p[3] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const col = { key: p[0], label: p[1], note: p[2] || '', type: 's', enumName: null, writable: false };
      flags.forEach(function (f) {
        if (f === 't') col.type = 's';
        else if (f === 'd') col.type = 'd';
        else if (f === 'n') col.type = 'n';
        else if (f === 'b') col.type = 'b';
        else if (f === 'j') col.type = 'j';
        else if (f === 'w') col.writable = true;
        else if (f.indexOf('e:') === 0) col.enumName = f.slice(2);
      });
      cols.push(col);
    });
    out[sk] = Object.assign({ key: sk, columns: cols }, SHEET_DEF[sk]);
  });
  out.START = Object.assign({ key: 'START', columns: [] }, SHEET_DEF.START);
  out.OVERVIEW = Object.assign({ key: 'OVERVIEW', columns: [] }, SHEET_DEF.OVERVIEW);
  return out;
})();

// ---------- Налаштування за замовчуванням ----------
// [ключ, тип (s|n|b|l), значення, пояснення, min, max]
const SETTINGS_DEF = [
  ['PROGRAM_ID', 's', 'mimeon_ua_alpha_2026', 'Код програми.'],
  ['CAMPAIGN_CODE', 's', 'mimeon_ua_alpha_2026', 'Спільний код кампанії для посилань магазинів. Не містить персональних даних.'],
  ['BOT_USERNAME', 's', '', 'Заповнюється автоматично через getMe під час setup_().'],
  ['TIMEZONE', 's', 'Europe/Kyiv', 'Часовий пояс розкладу та календарних днів.'],
  ['MAX_PARTICIPANTS', 'n', 0, 'Необов\'язкова межа набору. 0 = без обмеження (типово). Зменшення не зачіпає вже зареєстрованих.', 0, 100000],
  ['DEFAULT_TRIAL_DAYS', 'n', 14, 'Тривалість тесту, календарних днів.', 1, 60],
  ['MAX_TRIAL_DAYS', 'n', 21, 'Максимум з продовженням, календарних днів від початку.', 1, 90],
  ['DAY5_NUDGE_DAY', 'n', 5, 'День одного ненав\'язливого повідомлення.', 1, 60],
  ['SURVEY_REMINDER_OFFSETS', 'l', '3,6', 'Дні після доставленого запрошення для нагадувань.'],
  ['MAX_SURVEY_REMINDERS', 'n', 2, 'Максимум нагадувань про анкету на учасника сумарно.', 0, 5],
  ['FEEDBACK_WINDOW_DAYS', 'n', 7, 'Скільки днів після запрошення триває автоматичний збір.', 1, 60],
  ['QUIET_ALLOWED_START', 's', '10:00', 'Початок вікна планових повідомлень (включно), за Києвом.'],
  ['QUIET_ALLOWED_END', 's', '20:00', 'Кінець вікна планових повідомлень (не включно), за Києвом.'],
  ['SUPPORT_FIRST_RESPONSE_HOURS', 'n', 72, 'Орієнтир першої відповіді, годин.', 1, 720],
  ['SUPPORT_THREAD_DAYS', 'n', 14, 'Скільки днів останнє звернення вважається "поточним" для вільних повідомлень учасника.', 1, 90],
  ['EXPECTED_RELEASE_MONTH', 's', '2027-02', 'Лише очікування, формат РРРР-ММ. Нічого не нараховує.'],
  ['RELEASE_CONFIRMED', 'b', false, 'Ставте true ТІЛЬКИ після фактичного виходу релізу.'],
  ['REPORT_READY', 'b', false, 'true — звіт для учасників затверджено.'],
  ['REPORT_VERSION', 'n', 1, 'Версія звіту для учасників.', 1, 1000],
  ['APPLE_PROVIDER_TOKEN', 's', '', 'Provider token з App Store Connect (campaign link). Порожній — iOS-посилання без тегу.'],
  ['APP_STORE_BASE_URL', 's', 'https://apps.apple.com/us/app/mim-network/id6755737164', 'Базове посилання App Store.'],
  ['PLAY_STORE_BASE_URL', 's', 'https://play.google.com/store/apps/details?id=com.nowords.mim', 'Базове посилання Google Play.'],
  ['FILE_VIEWER_BASE_URL', 's', '', 'Чинний /exec URL deployment переглядача вкладень (див. README, крок про Web app).'],
  ['GOOGLE_UTM_SOURCE', 's', 'telegram', 'utm_source для Google Play.'],
  ['GOOGLE_UTM_MEDIUM', 's', 'bot', 'utm_medium для Google Play.'],
  ['TICK_WORK_BUDGET_SECONDS', 'n', 40, 'Робочий бюджет одного запуску, секунд.', 5, 240],
  ['MAX_SENDS_PER_TICK', 'n', 15, 'Максимум вихідних запитів Telegram за запуск.', 1, 60],
  ['MAX_UPDATES_PER_BATCH', 'n', 100, 'Максимум updates за одну порцію getUpdates.', 1, 100],
  ['MAX_RETRY_ATTEMPTS', 'n', 5, 'Максимум повторних спроб доставки/обробки.', 1, 20],
  ['FILE_VIEWER_MAX_BYTES', 'n', 10000000, 'Межа розміру файла для перегляду, байт. Telegram віддає боту файли лише до 20 МБ.', 1000, 20000000],
  ['VIEWER_URL_TTL_HOURS', 'n', 48, 'Строк дії посилання перегляду, годин. Посилання оновлюється автоматично.', 1, 720],
  ['DELIVERY_ENABLED', 'b', false, 'false — розсилка учасникам заборонена (дозволено лише власнику та TEST_CHAT_ALLOWLIST).'],
  ['TEST_MODE', 'b', true, 'true — обробляються й отримують відповіді лише чати зі списку TEST_CHAT_ALLOWLIST.'],
  ['TEST_CHAT_ALLOWLIST', 'l', '', 'Тестові chat_id власника/команди, через кому.'],
  ['SURVEY_VERSION', 's', '1.0', 'Версія анкети для нових проходжень.'],
  ['CONSENT_VERSION', 's', '1.0', 'Версія тексту згоди.'],
  ['ACK_ENABLED', 'b', true, 'true — бот одразу відповідає «Обробляю…» на повідомлення учасника (і прибирає це повідомлення після відповіді).'],
  ['ACK_HIDE_KEYBOARD', 'b', true, 'true — поки бот обробляє, кнопки знизу ховаються, щоб не клацати зайве. Нову клавіатуру приносить відповідь.'],
  ['FAST_POLL_SECONDS', 'n', 56, 'Швидка відповідь: скільки секунд запуск чекає нові повідомлення від Telegram (довге опитування). 56 майже закриває паузу між запусками. 0 = вимкнено (відповідь до ~1 хв).', 0, 58],
  ['FAST_POLL_IDLE_MINUTES', 'n', 10, 'Швидка відповідь діє стільки хвилин після останнього повідомлення від учасника.', 1, 120],
  ['FAST_POLL_DAILY_MINUTES', 'n', 120, 'Добовий ліміт швидкої відповіді, хвилин (ліміт Google на всі тригери — 6 год/добу для Workspace).', 0, 300],
  ['TRIGGER_DAILY_LIMIT_MINUTES', 'n', 360, 'Ліміт Google на сумарний час усіх запусків за добу, хвилин: 360 для Google Workspace, 90 для звичайного акаунта Gmail. Потрібен для запобіжника квоти й рядка в /status.', 30, 1440],
  ['QUOTA_GUARD_PERCENT', 'n', 85, 'Запобіжник: коли сьогоднішня робота запусків сягає цього відсотка ліміту, швидкий режим і /live призупиняються до завтра (базова робота бота триває).', 50, 100],
  ['OVERVIEW_REFRESH_MINUTES', 'n', 5, 'Як часто перераховується лист "Огляд" і колонки "Етап воронки"/"Що далі", хвилин.', 1, 120],
  ['TEAM_EDITOR_EMAILS', 'l', '', 'Email-адреси членів команди (редактори таблиці). Використовується для захисту аркушів.']
];

// ---------- Кнопки інтерфейсу (текст кнопок = текст повідомлення, яке надсилає Telegram) ----------
const BTN = {
  CONSENT: 'Погоджуюся, мені є 16 років',
  DECLINE: 'Не приєднуватися',
  PLATFORM_ANDROID: 'Android',
  PLATFORM_IOS: 'iPhone або iPad',
  PLATFORM_BOTH: 'Обидва',
  ROLE_AUTHOR: 'Автор',
  ROLE_VIEWER: 'Глядач',
  ROLE_BOTH: 'Обидва',
  MENU_MEMO: 'Пам\'ятка',
  MENU_SUPPORT: 'Повідомити про проблему',
  MENU_CRITICAL: 'КРИТИЧНЕ повідомлення',
  MENU_FEEDBACK: 'Дати фідбек',
  MENU_REWARD: 'Моя подяка',
  MENU_DATA: 'Участь і дані',
  MENU_GUIDE: 'Гайд',
  GIVE_FEEDBACK: 'Дати фідбек',
  EXTEND: 'Ще тиждень',
  STOP_REMINDERS: 'Не надсилати нагадування',
  DATA_VIEW: 'Переглянути мої дані',
  DATA_END: 'Завершити участь',
  DATA_MUTE: 'Не надсилати повідомлень',
  DATA_UNMUTE: 'Знову надсилати повідомлення',
  DATA_DELETE: 'Видалити мої дані',
  BACK: 'Назад',
  FB_CHANGE: 'Змінити відповіді анкети',
  FB_ADD: 'Додати новий фідбек',
  FB_EXTRA: 'Розповісти докладніше (4 питання)',
  EXTRA_YES: 'Так, відповім на 4 питання',
  EXTRA_NO: 'Не зараз',
  SURVEY_HELP: 'Допоможи згадати',
  DELETE_YES: 'Так, видалити мої дані',
  DELETE_NO: 'Скасувати',
  CANCEL: 'Скасувати',
  DONE: 'Готово',
  CHOOSE_ADD: 'Додати до останнього звернення',
  CHOOSE_NEW: 'Це проблема: нове звернення',
  CHOOSE_FEEDBACK: 'Це фідбек, не проблема',
  CHOOSE_UPGRADE: 'Зробити останнє звернення критичним',
  CHOOSE_NEW_CRITICAL: 'Нове критичне звернення',
  SURVEY_SKIP: 'Пропустити',
  SURVEY_LATER: 'Продовжити пізніше',
  SURVEY_RESET: 'Скинути вибір',
  HANDOFF: 'Передати в підтримку',
  HANDOFF_CRITICAL: 'Передати як КРИТИЧНЕ',
  HANDOFF_NO: 'Не потрібно',
  REWARD_PREMIUM: 'Місяць преміуму',
  REWARD_RESEARCH: 'Результати тестування',
  REWARD_PUBLIC: 'Публічна подяка',
  REWARD_CANCEL: 'Відмовитися від подяки',
  REWARD_CHANGE: 'Змінити вибір',
  REWARD_YES_CONTACT: 'Так, можна писати в цьому чаті',
  REWARD_NO_CONTACT: 'Ні, не писати',
  REWARD_YES_PUBLISH: 'Так, дозволяю опублікувати',
  REWARD_NO_PUBLISH: 'Ні, не публікувати',
  REWARD_NO_URL: 'Без посилання'
};

// ---------- Шаблони (редагуються в аркуші "Налаштування"; допустимі placeholders перелічені) ----------
// ім'я -> { text, placeholders[] }
const TEMPLATE_DEF = {
  greeting: {
    placeholders: [],
    text: 'Привіт! Тут можна приєднатися до української альфи Mimeon — мобільної платформи для спілкування через зображення.\n\n' +
      'Тестування добровільне й зазвичай триває 14 днів. Користуйся у своєму темпі; бажано зайти 2–3 рази в різні дні. Наприкінці бот запитає про твій досвід.\n\n' +
      'Тут можна повідомити про проблему й залишити фідбек. Дані та відповіді зберігатимуться в таблиці команди Mimeon для супроводу й дослідження. Зупинити повідомлення або запросити видалення даних можна через \'Участь і дані\'.'
  },
  consent_declined: {
    placeholders: [],
    text: 'Добре, без проблем. Нічого не потрібно робити. Якщо передумаєш, надішли /start. Якщо хочеш, щоб дані цього бота про тебе були видалені, надішли /delete.'
  },
  consent_repeat: { placeholders: [], text: 'Щоб приєднатися, потрібне підтвердження. Обери одну з кнопок нижче.' },
  platform_q: { placeholders: [], text: 'На чому ти користуватимешся Mimeon?' },
  role_q: { placeholders: [], text: 'Який варіант описує твою участь: автор, глядач чи обидва?' },
  platform_role_hint: { placeholders: [], text: 'Це реєстраційні відомості, не докази дослідження. Обери одну з кнопок нижче.' },
  store_links: { placeholders: [], text: 'Ось посилання на Mimeon. У магазині додаток може називатися MiM Network.' },
  memo: {
    placeholders: ['start_date', 'end_date'],
    text: 'У Mimeon спілкуються через зображення й емодзі. Переглядай стрічку, відкривай роботи, реагуй, зберігай або публікуй свої зображення — як тобі природно.\n\n' +
      'Не потрібно виконувати список завдань або звітувати після кожної дії. Якщо щось заважає, обери \'Повідомити про проблему\'. Якщо ситуація для тебе критична — \'КРИТИЧНЕ повідомлення\'.\n\n' +
      'Не зрозуміло, що де? Кнопка \'Гайд\' коротко показує, що вміє додаток.\n\n' +
      'Твій період тестування: {{start_date}}–{{end_date}}. Наприкінці бот запросить поділитися тим, що фактично відбулося.'
  },
  bot_short_description: {
    placeholders: [],
    text: 'Альфа-тест Mimeon: посилання на додаток, гайд, звернення до команди та фідбек. Українською.'
  },
  bot_description: {
    placeholders: [],
    text: 'Це бот альфа-тесту Mimeon — творчої платформи, де автори публікують роботи в 1 клік, а спілкування відбувається без слів: через емоції та творчість.\n\nТут ти зможеш:\n• отримати посилання на додаток і коротку пам\'ятку;\n• прочитати гайд, що вміє додаток;\n• повідомити про проблему (або про критичну);\n• розповісти, як тобі було, в короткій анкеті.\n\nУчасть добровільна. Завершити її й видалити свої дані можна будь-коли. Натисни «Почати».'
  },
  guide_intro: {
    placeholders: [],
    text: 'Гайд по Mimeon. Обери розділ кнопкою нижче: там коротко, що вміє додаток. Вийти — кнопка \'Назад\'.'
  },
  guide_empty: { placeholders: [], text: 'Гайд ще наповнюється. Заглянь трохи пізніше.' },
  memo_not_ready: { placeholders: [], text: 'Пам\'ятка з\'явиться після того, як ти завершиш реєстрацію й отримаєш посилання на додаток.' },
  waiting_capacity: {
    placeholders: [],
    text: 'Дякуємо, що хочеш приєднатися! Зараз усі місця альфи зайняті. Ми збережемо твоє місце в черзі за датою реєстрації й напишемо тобі в цьому чаті, коли воно з\'явиться. Якщо передумаєш, скористайся пунктом \'Участь і дані\'.'
  },
  capacity_open: { placeholders: [], text: 'З\'явилося місце в альфі Mimeon! Щоб приєднатися, підтверди участь кнопкою нижче.' },
  help: {
    placeholders: [],
    text: 'Що тут можна робити:\n• \'Пам\'ятка\' — коротке пояснення й посилання.\n• \'Гайд\' — що вміє додаток, по розділах.\n• \'Повідомити про проблему\' — звичайне звернення.\n• \'КРИТИЧНЕ повідомлення\' — звернення, яке додатково надійде особисто засновнику.\n• \'Дати фідбек\' — розповісти про свій досвід.\n• \'Участь і дані\' — вимкнути повідомлення, завершити участь або видалити дані.'
  },
  my_data_head: { placeholders: [], text: 'Ось що бот зараз зберігає про тебе в таблиці. Це копія твоїх даних на цю мить.' },
  my_data_foot: {
    placeholders: [],
    text: 'Не показуємо: службові примітки команди про тебе. Їх можна запросити через «Повідомити про проблему». Щоб виправити чи доповнити дані, напиши в підтримку. Щоб видалити — «Участь і дані» → «Видалити мої дані».'
  },
  data_menu: { placeholders: [], text: 'Участь і дані. Обери дію. Жодна з них не потребує пояснення.' },
  ended: {
    placeholders: [],
    text: 'Участь завершено, нагадування зупинено. Уже наданий фідбек і право на обрану подяку збережені. Якщо захочеш, можна ще написати тут.'
  },
  muted: {
    placeholders: [],
    text: 'Добре, проактивні повідомлення вимкнено. Дані й право на подяку збережені. Якщо ти напишеш сам, бот відповість.'
  },
  unmuted: { placeholders: [], text: 'Готово, повідомлення знову увімкнено.' },
  reminders_off: { placeholders: [], text: 'Добре, нагадувань про фідбек більше не буде. Фідбек можна залишити в будь-який час.' },
  delete_confirm: {
    placeholders: [],
    text: 'Видалити дані, які цей бот зібрав про тебе в таблиці? Це також видалить збережені відповіді й відомості для подяки. Акаунт у самому Mimeon цією дією не видаляється.'
  },
  delete_cancelled: { placeholders: [], text: 'Добре, нічого не видалено.' },
  delete_done: {
    placeholders: ['summary', 'external'],
    text: 'Готово. Видалено в цьому боті: {{summary}}.\n\nЦя дія не видаляє: акаунт у Mimeon, історію чату на серверах Telegram (її можна очистити в Telegram){{external}}.\n\nЯкщо захочеш повернутися, надішли /start.'
  },
  extension_done: {
    placeholders: ['end_date'],
    text: 'Тест продовжено до {{end_date}}. Наприкінці бот знову запросить розповісти про досвід.'
  },
  extension_unavailable: { placeholders: [], text: 'Продовження зараз недоступне: його можна використати один раз, до завершення максимального строку й анкети.' },
  day5: {
    placeholders: [],
    text: 'Якщо буде нагода, зайди в Mimeon ще раз у зручний час. Якщо щось завадило почати або продовжити, можна повідомити про це тут.'
  },
  survey_invite: {
    placeholders: [],
    text: 'Твій період тестування Mimeon завершився. Розкажи, що фактично відбулося, навіть якщо ти не почав/ла або скористався/лась лише один раз.\n\nПитання залежать від твого досвіду. Можна відповідати частинами й продовжити пізніше.'
  },
  survey_reminder: {
    placeholders: [],
    text: 'Можна повернутися до фідбеку про Mimeon у зручний час. Уже надані відповіді збережені. Досвід без встановлення або з труднощами теж важливий.'
  },
  support_prompt: { placeholders: [], text: 'Опиши, що сталося: що ти робив(ла), що очікував(ла) і що вийшло. Можна додати скриншот або коротке відео. Щоб скасувати, надішли /cancel.' },
  critical_prompt: { placeholders: [], text: 'Опиши, що сталося і чому це критично для тебе. Можна додати скриншот або коротке відео. Це звернення додатково надійде особисто засновнику. Щоб скасувати, надішли /cancel.' },
  support_saved: {
    placeholders: ['ticket_id', 'hours'],
    text: 'Звернення {{ticket_id}} збережено. Команда відповість тут; орієнтовний строк першої відповіді — до {{hours}} год (це орієнтир, а не гарантія).'
  },
  critical_saved: {
    placeholders: ['ticket_id', 'hours'],
    text: 'Збережено як КРИТИЧНЕ звернення {{ticket_id}}. Сповіщення засновнику поставлено в чергу — підтвердимо, коли воно буде доставлене. Орієнтовний строк відповіді — до {{hours}} год (це орієнтир, а не гарантія).'
  },
  critical_upgraded: {
    placeholders: ['ticket_id'],
    text: 'Звернення {{ticket_id}} позначено як КРИТИЧНЕ. Сповіщення засновнику поставлено в чергу — підтвердимо, коли воно буде доставлене.'
  },
  critical_alert_delivered: {
    placeholders: ['ticket_id'],
    text: 'Сповіщення засновнику про звернення {{ticket_id}} доставлено. Негайної відповіді це не гарантує, але звернення позначено як критичне.'
  },
  support_details_prompt: {
    placeholders: [],
    text: 'Якщо хочеш, додай деталі: що відбувалося перед проблемою, модель пристрою та версію системи (напиши сам/сама — бот цього не визначає). Можна надіслати ще скриншот чи відео. Коли закінчиш, натисни «Готово».'
  },
  support_details_done: { placeholders: ['ticket_id'], text: 'Дякуємо! Усе додано до звернення {{ticket_id}}. Відповідь прийде в цей чат.' },
  support_added: { placeholders: ['ticket_id'], text: 'Додано до звернення {{ticket_id}}. Можна додати ще або натиснути «Готово».' },
  support_reply_added: { placeholders: ['ticket_id'], text: 'Дякуємо, додано до звернення {{ticket_id}}. Команда побачить твою відповідь.' },
  support_choose: {
    placeholders: ['ticket_id'],
    text: 'Бачу нещодавнє звернення {{ticket_id}}. Додати це повідомлення до нього чи створити нове звернення?'
  },
  critical_choose: {
    placeholders: ['ticket_id'],
    text: 'У тебе є відкрите звернення {{ticket_id}}. Зробити його критичним чи створити нове критичне звернення?'
  },
  support_cancelled: { placeholders: [], text: 'Добре, скасовано. Нічого не створено.' },
  support_choose_cancelled: { placeholders: [], text: 'Добре. Повідомлення збережено без звернення; якщо захочеш, створи звернення через меню.' },
  support_choose_done: { placeholders: ['ticket_id'], text: 'Готово, звернення {{ticket_id}} оновлено.' },
  attachment_too_large: {
    placeholders: ['mb'],
    text: 'Файл завеликий для перегляду командою (понад {{mb}} МБ). Ми зберегли лише відомості про нього. Якщо можеш, надішли коротшу версію або скриншот.'
  },
  survey_intro: {
    placeholders: [],
    text: 'Дякуємо, що ділишся досвідом. Питання йдуть по одному й залежать від того, що з Mimeon реально сталося. Усі відповіді, зокрема «Не пам\'ятаю» або «Нічого», однаково важливі й нічого не псують.\n\nМожна відповідати частинами: «Продовжити пізніше» зберігає місце, а «Пропустити» пропускає питання.'
  },
  survey_resume: { placeholders: [], text: 'Повертаємося до анкети з того самого місця. Уже надані відповіді збережені.' },
  survey_later: { placeholders: [], text: 'Збережено. Повернутися до анкети можна в будь-який час кнопкою «Дати фідбек».' },
  survey_back_note: { placeholders: ['answer'], text: 'Попередня відповідь: {{answer}}\nЯкщо відповіси інакше, нова відповідь збережеться як оновлення; попередня лишиться в історії.' },
  survey_back_none: { placeholders: [], text: 'Це перше питання, повертатися нікуди.' },
  survey_clarify: {
    placeholders: [],
    text: 'Не впевнений, до якого питання належить це повідомлення, тому не зарахував його як відповідь. Воно збережене. Надішли відповідь на поточне питання ще раз (краще натиснути «Відповісти» на питанні).'
  },
  survey_choose_hint: { placeholders: [], text: 'На це питання відповідають кнопками нижче. Повідомлення збережено окремо; обери варіант або «Пропустити».' },
  survey_multi_conflict: {
    placeholders: ['selected'],
    text: 'Цей варіант суперечить уже обраному ({{selected}}), тому я залишив твій перший вибір без змін. Щоб змінити, натисни «Скинути вибір» і обери наново.'
  },
  survey_multi_empty: { placeholders: [], text: 'Спершу обери хоча б один варіант або натисни «Пропустити».' },
  survey_multi_state: { placeholders: ['selected'], text: 'Обрано: {{selected}}. Додай ще або натисни «Готово».' },
  survey_resume_hint: { placeholders: [], text: 'Анкета чекає на тебе. Коли буде зручно, натисни «Дати фідбек» — продовжимо з того самого питання.' },
  survey_not_available: {
    placeholders: [],
    text: 'Анкета стане доступною, коли ти отримаєш посилання й розпочнеш тест. Якщо щось заважає, можна повідомити про проблему.'
  },
  ack_processing: { placeholders: [], text: '⏳ Обробляю ▰▱▱' },
  ack_almost: { placeholders: [], text: '⏳ Майже готово ▰▰▱' },
  ack_restore: { placeholders: [], text: 'Кнопки повернуто. Обери дію або напиши відповідь.' },
  survey_extra_offer: {
    placeholders: [],
    text: 'Хочеш розповісти докладніше? Є 4 короткі необов\'язкові питання: чого не вистачало, що заважало, що було неочевидно і що сподобалося найбільше. Займе 2–3 хвилини.'
  },
  survey_extra_intro: {
    placeholders: [],
    text: 'Дякуємо! 4 короткі питання. Усі можна пропускати. Конкретна ситуація цінніша за загальне враження, а «Допоможи згадати» підкаже, з чого почати.'
  },
  survey_extra_done: { placeholders: [], text: 'Дякуємо, це дуже допомагає! Змінити відповіді чи додати новий фідбек можна будь-коли: «Дати фідбек».' },
  survey_extra_declined: { placeholders: [], text: 'Гаразд. Якщо захочеш розповісти докладніше, натисни «Дати фідбек» і обери «Розповісти докладніше».' },
  free_choose: {
    placeholders: [],
    text: 'Повідомлення збережено. Що це?\n\n• «Це проблема» — створю звичайне звернення.\n• «Це фідбек» — збережу як відгук, без звернення. Підійде і для доброго, і для поганого.\n• «Нове критичне звернення» — лише якщо проблема дуже серйозна: ми сповістимо засновника.'
  },
  free_choose_ticket: {
    placeholders: ['ticket_id'],
    text: 'Повідомлення збережено. Що це?\n\n• «Додати до останнього звернення» — додам до {{ticket_id}}.\n• «Це проблема» — створю нове звичайне звернення.\n• «Це фідбек» — збережу як відгук, без звернення. Підійде і для доброго, і для поганого.\n• «Нове критичне звернення» — лише якщо проблема дуже серйозна: ми сповістимо засновника.'
  },
  free_feedback_saved: { placeholders: [], text: 'Дякуємо! Збережено як фідбек, без звернення. Додати ще можна будь-коли: просто напиши сюди.' },
  fb_menu: {
    placeholders: [],
    text: 'Ти вже заповнив(ла) анкету. Що хочеш зробити?\n\n• «Змінити відповіді анкети» — виправити відповідь на питання.\n• «Додати новий фідбек» — написати щось нове: і добре, і погане. Це не звернення і не КРИТИЧНЕ повідомлення.\n• «Розповісти докладніше» — 4 додаткові питання (якщо ще не відповідав/ла).'
  },
  fb_pick: {
    placeholders: ['list'],
    text: 'Які відповіді зараз збережено:\n\n{{list}}\n\nНатисни номер питання, яке хочеш змінити. Стара відповідь залишиться в історії, нова стане актуальною.'
  },
  fb_pick_unknown: { placeholders: [], text: 'Натисни номер питання кнопкою або «Назад».' },
  fb_add_prompt: {
    placeholders: [],
    text: 'Напиши, що хочеш додати: що сподобалося, що було незрозуміло, що не вийшло. Можна кілька повідомлень, фото, скриншоти чи голосові. Це не звернення: команда прочитає це як додатковий фідбек.\n\nКоли закінчиш, натисни «Готово».'
  },
  fb_added: { placeholders: [], text: 'Додано. Можеш надіслати ще щось або натиснути «Готово».' },
  fb_add_done: { placeholders: [], text: 'Дякуємо! Новий фідбек збережено. Додати ще можна будь-коли: «Дати фідбек».' },
  fb_add_empty: { placeholders: [], text: 'Нічого не додано. Якщо захочеш, натисни «Дати фідбек» ще раз.' },
  fb_closed: { placeholders: [], text: 'Гаразд. Повернутися сюди можна будь-коли: «Дати фідбек».' },
  fb_later_hint: { placeholders: [], text: 'Змінити відповіді, додати новий фідбек або відповісти на додаткові питання можна пізніше: кнопка «Дати фідбек».' },
  survey_already_done: {
    placeholders: [],
    text: 'Анкету вже завершено, дякуємо! Якщо хочеш додати ще щось, натисни «Повідомити про проблему» або просто напиши сюди.'
  },
  survey_done: {
    placeholders: [],
    text: 'Дякуємо, анкету завершено! Твої відповіді збережені. Подяка належить кожному, хто поділився досвідом, — незалежно від того, чи все вийшло. Обрати її можна кнопкою «Моя подяка» (видача — після релізу).'
  },
  survey_done_no_feedback: {
    placeholders: [],
    text: 'Анкету завершено: усі питання пропущено, і це нормально. Подяка належить тим, хто поділився досвідом бодай однією відповіддю. Якщо захочеш, просто напиши сюди кілька слів або опиши проблему.'
  },
  survey_handoff_offer: {
    placeholders: [],
    text: 'Ти описав(ла) труднощі. Якщо хочеш, передам цей опис команді як звернення — без повторного заповнення. Звернення стане КРИТИЧНИМ лише якщо ти сам цього захочеш.'
  },
  survey_handoff_declined: { placeholders: [], text: 'Добре, не передаю. Якщо передумаєш, натисни «Повідомити про проблему».' },
  reward_not_eligible: {
    placeholders: [],
    text: 'Подяка належить кожному, хто поділився досвідом, навіть якщо ти не встановлював(ла) додаток або щось не вийшло. Достатньо хоча б однієї відповіді в анкеті або опису проблеми. Натисни «Дати фідбек», коли буде зручно.'
  },
  reward_choose: {
    placeholders: ['release'],
    text: 'Обери одну подяку (її можна змінити до моменту видачі). Видача — після підтвердженого релізу; очікуємо приблизно {{release}}, але це лише орієнтир.\n\n• Місяць преміуму — потрібен email, за яким знайдемо твій акаунт.\n• Результати тестування — узагальнений знеособлений звіт із висновками, надішлемо текстом тут.\n• Публічна подяка — твоє ім\'я або псевдонім серед перших учасників на сторінці сайту (лише за твоєї явної згоди).'
  },
  reward_current: {
    placeholders: ['choice', 'status'],
    text: 'Твоя подяка: {{choice}}.\nСтатус: {{status}}.\nДо видачі можна змінити вибір або відмовитися.'
  },
  reward_current_fulfilled: { placeholders: ['choice'], text: 'Твоя подяка «{{choice}}» уже виконана. Дякуємо ще раз!' },
  reward_cancelled: { placeholders: [], text: 'Добре, подяку скасовано. Якщо передумаєш, натисни «Моя подяка».' },
  reward_email_prompt: {
    placeholders: [],
    text: 'Напиши email, за яким ми знайдемо твій акаунт Mimeon для місяця преміуму. Він потрібен лише для цього, ніколи не публікується. Щоб скасувати вибір, надішли /cancel.'
  },
  reward_email_invalid: { placeholders: [], text: 'Це не схоже на email. Напиши адресу у вигляді name@example.com або надішли /cancel.' },
  reward_name_prompt: {
    placeholders: [],
    text: 'Як підписати твою подяку на сторінці сайту? Напиши ім\'я або псевдонім для публікації (не береться з Telegram автоматично). Щоб скасувати вибір, надішли /cancel.'
  },
  reward_name_invalid: { placeholders: [], text: 'Напиши ім\'я або псевдонім до 60 символів, без посилань. Або надішли /cancel.' },
  reward_url_prompt: { placeholders: [], text: 'Якщо хочеш, додай посилання на свій профіль чи сайт (https://…) — його покажемо поруч із іменем. Або натисни «Без посилання».' },
  reward_url_invalid: { placeholders: [], text: 'Посилання має починатися з https://. Надішли його ще раз або натисни «Без посилання».' },
  reward_publish_consent: {
    placeholders: ['name', 'url'],
    text: 'Підтверди публікацію: на сторінці сайту з\'явиться «{{name}}»{{url}}. Email і Telegram-дані не публікуються. Дозволяєш?'
  },
  reward_contact_consent: {
    placeholders: [],
    text: 'Чи можна написати тобі в цьому чаті щодо цієї подяки (уточнити акаунт або повідомити, що вона готова)? Без цієї згоди я нічого не надсилатиму сам.'
  },
  reward_saved: {
    placeholders: ['choice'],
    text: 'Записав: {{choice}}. Видача — після підтвердженого релізу. До видачі можна змінити вибір у «Моя подяка».'
  },
  reward_saved_no_contact: {
    placeholders: ['choice'],
    text: 'Записав: {{choice}}. Оскільки ти не дозволив писати щодо подяки, сам я нічого не надсилатиму; стан завжди можна подивитися в «Моя подяка».'
  },
  reward_publish_declined: { placeholders: [], text: 'Добре, без публікації. Обери іншу подяку або залиш усе як є.' },
  reward_done_premium: {
    placeholders: ['from', 'to'],
    text: 'Твій місяць преміуму Mimeon активовано: {{from}} — {{to}}. Дякуємо, що поділився(лась) досвідом!'
  },
  reward_done_public: {
    placeholders: ['url'],
    text: 'Твою подяку опубліковано: {{url}}. Дякуємо, що ти серед перших учасників!'
  },
  reward_done_research: {
    placeholders: ['report'],
    text: 'Ось узагальнені результати тестування (знеособлені):\n\n{{report}}'
  },
  reward_account_clarify: {
    placeholders: [],
    text: 'Нам не вдалося знайти акаунт Mimeon за вказаним email. Напиши сюди, будь ласка, як ти входиш у Mimeon (Google чи Apple) і яким email/іменем користуєшся: твоє повідомлення потрапить до команди. Подяку це не скасовує.'
  },
  feature_unavailable: { placeholders: [], text: 'Ця можливість буде доступна на наступному етапі запуску. Твоє повідомлення збережено в журналі.' },
  unknown_text: { placeholders: [], text: 'Не зовсім зрозумів. Скористайся кнопками меню нижче або надішли /help.' },
  menu_back: { placeholders: [], text: 'Головне меню.' },
  owner_not_participant: {
    placeholders: [],
    text: 'Це службовий чат власника Mimeon alpha. Власник не стає учасником автоматично. Доступні команди: /status, /stats (воронка). Щоб протестувати як учасник, додайте цей chat_id до TEST_CHAT_ALLOWLIST у "Налаштування".'
  },
  owner_status: { placeholders: ['status'], text: '{{status}}' },
  owner_bind_ok: { placeholders: [], text: 'Готово: цей чат прив\'язано як власника Mimeon alpha. Перевірка доставки пройшла.' },
  owner_alert: {
    placeholders: ['ticket_id', 'created_at_local', 'safe_preview', 'sheet_url'],
    text: 'КРИТИЧНЕ повідомлення від учасника Mimeon.\n\nЗвернення: {{ticket_id}}\nЧас: {{created_at_local}}\nОпис: {{safe_preview}}\n\nПовна інформація та відповідь користувачу: {{sheet_url}}'
  },
  owner_incident: {
    placeholders: ['component', 'code', 'summary', 'incident_id'],
    text: 'Технічний інцидент Mimeon alpha.\nКомпонент: {{component}}\nКод: {{code}}\nОпис: {{summary}}\nID: {{incident_id}} (див. аркуш "Техжурнал").'
  }
};

// Мінімальний FAQ (розділ 11.5)
const FAQ_DEF = [
  ['Мета', 'Перевіряємо фактичний досвід, отримані результати, зрозумілість і проблеми'],
  ['Дії', 'Самостійне використання, бажано 2–3 рази в різні дні, фідбек наприкінці'],
  ['Назва в магазині', 'Mimeon може відображатися як MiM Network'],
  ['Авторизація', 'Google/Apple; бот не приймає паролі або коди входу в додаток'],
  ['Текст', 'У додатку спілкування через зображення й емодзі; текст у цьому боті дозволений'],
  ['Не вдалося почати', 'Це теж фідбек; опиши етап і те, що сталося'],
  ['Публікація не вдалася', 'Приймаємо опис і скриншот; не гарантуємо проходження модерації'],
  ['Підтримка', 'Звичайне або критичне звернення через меню'],
  ['Винагорода', 'Один із трьох варіантів після релізу; позитивність не є умовою'],
  ['Вихід', 'Через "Участь і дані", без обов\'язкового пояснення']
];

// Гайд (початкові сторінки; далі команда редагує аркуш "Гайд"). Опис — за PRD MVP, без вигаданих функцій.
const GUIDE_DEF = [
  ['g1', 1, 'Що це', 'Mimeon — це творча платформа. Вона допомагає авторам розмістити свою роботу в 1 клік. Підбір найкращих категорій і просування в стрічці платформа бере на себе.\n\nЗавдяки цьому кожен бачить у стрічці те, що найкраще відповідає його вподобанням, і легко знаходить матеріал для натхнення.\n\nСпілкування між учасниками повністю без слів. Для взаємодії з авторами й іншими користувачами ми використовуємо емоції та власну творчість.\n\nВесь фокус на творчості й простоті. Ніяких мовних рамок і обмежень.\n\nУ магазині додаток може називатися MiM Network.'],
  ['g2', 2, 'Початок', 'Вхід — через обліковий запис Google або Apple. Бот не просить і не приймає паролі чи коди входу.\n\nПісля входу додаток проведе коротким знайомством. Його можна повторити з профілю.\n\nНе вдалося почати? Це теж фідбек. Натисни \'Повідомити про проблему\' і опиши, на якому кроці зупинився.'],
  ['g3', 3, 'Стрічка', 'Стрічка показує роботи інших людей. Відкрий роботу, щоб розглянути її.\n\nЛайк один: серце. Його можна поставити й зняти.\n\nКоментар — це зображення або набір із 8 емодзі: серце, рука, оплески, вогонь, сміх, закохані очі, здивування, смуток. Кількість і порядок будь-які.\n\nПід коментарем можна відповісти, але лише на один рівень вглиб. Свої коментарі можна видалити. Власник роботи може видалити будь-які коментарі під нею.'],
  ['g4', 4, 'Публікація', 'Свою роботу можна взяти з галереї або зробити камерою. Одна публікація — одне нерухоме зображення. Формати: jpg, jpeg, png, webp. Розмір — до 10 МБ.\n\nПеред публікацією є прості інструменти: обрізання, розмір, фільтри, розмиття.\n\nСпершу робота проходить перевірку. Автоматична триває до 5 секунд. Ручна — до 72 годин. Після схвалення робота стає видимою для інших.\n\nЗаборонено: текст і цифри на зображенні, сцени насильства й сексу. Якщо роботу заблоковано, можна відредагувати її й спробувати знову або подати апеляцію.\n\nОпубліковану роботу можна видалити. Редагувати її вже не можна.\n\nДопустимі й зображення, створені ШІ, якщо це твоя робота або в тебе є право її використовувати.'],
  ['g5', 5, 'Збережене', 'Роботу можна додати в обране й прибрати з нього. Так само можна додати в обране автора.\n\nЕкран \'Друзі\' — це список твоїх обраних авторів для швидкого переходу до їхніх галерей. Це не взаємна дружба.\n\nУ твоїй галереї є вкладки: мої роботи, збережені, заблоковані (ті, що не пройшли перевірку).'],
  ['g6', 6, 'Профіль', 'У профілі: світла або темна тема, зміна аватара, доступ до сповіщень, правила, підтримка, видалення акаунта.\n\nАватар на початку призначається автоматично. Нове зображення проходить ту саму перевірку.\n\nСповіщення про лайки, коментарі й перевірку приходять у додатку та пушем. Підтримка є на кожному екрані; відповідь приходить на пошту, яку ти вкажеш у формі.\n\nПоділитися роботою можна посиланням. Якщо роботу вже видалено або заблоковано, посилання відкриє загальну стрічку.'],
  ['g7', 7, 'У боті', 'Що можна зробити тут, у боті:\n• \'Повідомити про проблему\' — звичайне звернення. Можна додати скриншот.\n• \'КРИТИЧНЕ повідомлення\' — те саме, але воно додатково одразу надійде засновнику.\n• \'Дати фідбек\' — коротка анкета про твій досвід. Її можна припинити й продовжити пізніше.\n• \'Моя подяка\' — вибір подяки після релізу.\n• \'Участь і дані\' — вимкнути повідомлення, подивитися свої дані, завершити участь або видалити дані.\n\nПісля запуску додатка не потрібно виконувати завдання чи звітувати після кожної дії. Користуйся так, як природно.']
];

// Меню команд Telegram (кнопка «Меню» біля поля вводу). Лише українською: тест проходить для українців.
const BOT_COMMANDS = [
  ['start', 'Почати або повернутися до меню'],
  ['guide', 'Гайд: що вміє додаток'],
  ['support', 'Повідомити про проблему'],
  ['critical', 'КРИТИЧНЕ повідомлення'],
  ['feedback', 'Дати фідбек'],
  ['reward', 'Моя подяка'],
  ['mydata', 'Мої дані'],
  ['help', 'Що тут можна робити']
];

// Оновлення стандартних текстів при міграції. Правило: якщо в таблиці лежить ТОЧНО старий стандартний текст
// (команда його не змінювала), він замінюється новим. Тексти, які змінила команда, не чіпаються.
const TEXT_UPGRADES = [
  { kind: 'param', key: 'FAST_POLL_SECONDS', old: '48', now: '56' },
  { kind: 'template', key: 'bot_description', old: "Це бот альфа-тесту Mimeon — соціальної мережі без слів, де спілкуються зображеннями й емодзі.\n\nТут ти зможеш:\n• отримати посилання на додаток і коротку пам'ятку;\n• прочитати гайд, що вміє додаток;\n• повідомити про проблему (або про критичну);\n• розповісти, як тобі було, в короткій анкеті.\n\nУчасть добровільна. Завершити її й видалити свої дані можна будь-коли. Натисни «Почати».", now: "Це бот альфа-тесту Mimeon — творчої платформи, де автори публікують роботи в 1 клік, а спілкування відбувається без слів: через емоції та творчість.\n\nТут ти зможеш:\n• отримати посилання на додаток і коротку пам'ятку;\n• прочитати гайд, що вміє додаток;\n• повідомити про проблему (або про критичну);\n• розповісти, як тобі було, в короткій анкеті.\n\nУчасть добровільна. Завершити її й видалити свої дані можна будь-коли. Натисни «Почати»." },
  { kind: 'guide', key: 'g1', old: "Mimeon — соцмережа без слів. Люди спілкуються зображеннями й емодзі: без нікнеймів, постів і довгих текстів.\n\nУ додатку ти можеш дивитися чужі роботи, реагувати, зберігати їх і публікувати власні зображення. Допустимі й зображення, створені ШІ, якщо це твоя робота або в тебе є право її використовувати.\n\nУ магазині додаток може називатися MiM Network.", now: "Mimeon — це творча платформа. Вона допомагає авторам розмістити свою роботу в 1 клік. Підбір найкращих категорій і просування в стрічці платформа бере на себе.\n\nЗавдяки цьому кожен бачить у стрічці те, що найкраще відповідає його вподобанням, і легко знаходить матеріал для натхнення.\n\nСпілкування між учасниками повністю без слів. Для взаємодії з авторами й іншими користувачами ми використовуємо емоції та власну творчість.\n\nВесь фокус на творчості й простоті. Ніяких мовних рамок і обмежень.\n\nУ магазині додаток може називатися MiM Network." },
  { kind: 'guide', key: 'g4', old: "Свою роботу можна взяти з галереї або зробити камерою. Одна публікація — одне нерухоме зображення. Формати: jpg, jpeg, png, webp. Розмір — до 10 МБ.\n\nПеред публікацією є прості інструменти: обрізання, розмір, фільтри, розмиття.\n\nСпершу робота проходить перевірку. Автоматична триває до 5 секунд. Ручна — до 72 годин. Після схвалення робота стає видимою для інших.\n\nЗаборонено: текст і цифри на зображенні, сцени насильства й сексу. Якщо роботу заблоковано, можна відредагувати її й спробувати знову або подати апеляцію.\n\nОпубліковану роботу можна видалити. Редагувати її вже не можна.", now: "Свою роботу можна взяти з галереї або зробити камерою. Одна публікація — одне нерухоме зображення. Формати: jpg, jpeg, png, webp. Розмір — до 10 МБ.\n\nПеред публікацією є прості інструменти: обрізання, розмір, фільтри, розмиття.\n\nСпершу робота проходить перевірку. Автоматична триває до 5 секунд. Ручна — до 72 годин. Після схвалення робота стає видимою для інших.\n\nЗаборонено: текст і цифри на зображенні, сцени насильства й сексу. Якщо роботу заблоковано, можна відредагувати її й спробувати знову або подати апеляцію.\n\nОпубліковану роботу можна видалити. Редагувати її вже не можна.\n\nДопустимі й зображення, створені ШІ, якщо це твоя робота або в тебе є право її використовувати." }
];

// ---------- Технічні константи ----------
const TG_API_HOST = 'https://api.telegram.org';
const TG_ALLOWED_UPDATES = ['message', 'edited_message', 'my_chat_member'];
const TG_TEXT_LIMIT = 4096;
const INBOX_PAYLOAD_PART = 45000;     // межа клітинки Sheets 50 000 символів
const SENDING_STALE_MINUTES = 5;      // "sending" старше — вважаємо delivery_unknown
const HEARTBEAT_GAP_MINUTES = 10;
const INBOX_LOSS_GAP_HOURS = 24;
const LOCK_WAIT_MS = 500;
const PRIORITY = { OWNER_ALERT: 1, SUPPORT: 2, DIALOG: 3, REWARD_DONE: 4, SCHEDULED: 5 };
