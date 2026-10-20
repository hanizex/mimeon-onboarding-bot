/**
 * Survey.gs — фінальна анкета (The Mom Test, розділ 7 вимог).
 *
 * Канонічний стан анкети — рядок аркуша "Опитування" + відповіді в "Відповіді анкети".
 * ПОТОЧНЕ питання під час розмови береться з dialog_context_json учасника (його оновлення — єдина точка фіксації
 * ходу разом з last_event_id), а рядок "Опитування" лише дзеркалить його. Тому повторна обробка тієї самої події
 * (після збою) читає старий стан, знаходить уже збережену відповідь за детермінованим answer_id й дає ті самі результати.
 *
 * Питання по одному. Текстові питання — клавіатура з готовими відповідями ("Не пам'ятаю" тощо) і кнопками
 * "Назад / Пропустити / Продовжити пізніше". Застаріла відповідь не зараховується іншому питанню
 * (reply_to_message_id → питання; час повідомлення проти часу доставки питання; питання ще не доставлене).
 */

const SURVEY_DK = "Не пам'ятаю";
const SURVEY_NOTE_VISUAL = 'Це може бути будь-який додаток, сайт чи чат, де є зображення, малюнки, фото або інші візуальні роботи.';
/**
 * Питання анкети. Поля: type, text, options/specials; необов'язкові: note — коротке пояснення (показується завжди),
 * eg — приклад ФОРМИ відповіді (без підказки змісту), recall — підказки «Допоможи згадати», media — можна додати фото/голосове.
 */
const SURVEY_Q = {
  G1: {
    type: 'choice', text: 'Чи встановлював/ла ти Mimeon на свій телефон або планшет під час цього тестування?',
    note: 'Обери один варіант. Якщо не певен/на, обери «Не пам\'ятаю».',
    options: [['new_install', 'Встановив/ла під час тесту'], ['existing_install', 'Вже був встановлений до запрошення'], ['not_installed', 'Не встановлював/ла'], ['unknown', SURVEY_DK]]
  },
  G2: {
    type: 'choice', text: 'У скільки різних днів за цей період ти відкривав/ла Mimeon?',
    note: 'Рахуй дні, коли ти хоча б раз відкрив/ла додаток, навіть на хвилину. Приблизно — нормально.',
    options: [['days_0', 'Жодного'], ['days_1', 'В один день'], ['days_2_3', 'У 2–3 дні'], ['days_4_7', 'У 4–7 днів'], ['days_8_plus', 'У 8 або більше днів'], ['unknown', SURVEY_DK]]
  },
  A1: {
    type: 'choice', text: 'На якому етапі ти зупинився/лась?',
    note: 'Обери найближчий до твоєї ситуації. Точність не потрібна.',
    options: [['not_opened_link', 'Не відкривав/ла посилання'], ['opened_store_page', 'Відкрив/ла сторінку магазину'], ['started_install', 'Почав/ла встановлення'],
      ['installed_not_opened', 'Встановив/ла, але не відкрив/ла'], ['tried_open_app', 'Спробував/ла відкрити додаток'], ['stopped_at_login', 'Зупинився/лась на вході'],
      ['other_stage', 'Інший етап'], ['unknown', SURVEY_DK]]
  },
  A2: {
    type: 'text', media: true, text: 'Згадай цей момент. Що саме відбулося?',
    eg: 'Приклад форми відповіді: що ти зробив/ла → що побачив/ла → що було далі. Можна коротко, кількома словами.',
    recall: ['Де ти був/була і з якого пристрою це відбувалося?', 'Що ти натискав/ла?', 'Що ти бачив/ла на екрані? Можна надіслати скриншот чи фото.', 'Що було останнім, перед тим як ти зупинився/лась?'],
    specials: [['dont_remember', SURVEY_DK]]
  },
  A3: {
    type: 'text', text: 'Що ти зробив/ла після цього?',
    eg: 'Приклад форми відповіді: «Закрив/ла додаток», «Спробував/ла ще раз», «Написав/ла комусь».',
    recall: ['Ти закрив/ла додаток чи пробував/ла далі?', 'Шукав/ла допомогу чи писав/ла нам?', 'Повертався/лась до цього пізніше?'],
    specials: [['nothing', 'Нічого'], ['dont_remember', SURVEY_DK]]
  },
  A4: {
    type: 'text', text: 'За цей період де ти востаннє переглядав/ла або публікував/ла візуальні роботи?',
    note: SURVEY_NOTE_VISUAL,
    eg: 'Приклад форми відповіді: назва додатка чи сайту й що ти там робив/ла.',
    recall: ['Згадай останній раз, коли ти дивився/лась чиїсь роботи.', 'Де це було: додаток, сайт, чат?', 'Що ти там робив/ла: дивився/лась, зберігав/ла, публікував/ла?'],
    specials: [['no_case', 'Такого випадку не було'], ['dont_remember', SURVEY_DK]]
  },
  U1: {
    type: 'text', text: 'Згадай останнє відкриття Mimeon у цей період. Що стало приводом відкрити його саме тоді?',
    note: 'Конкретний випадок цінніший за загальне враження.',
    eg: 'Приклад форми відповіді: коли це було, що ти робив/ла перед цим, що підштовхнуло відкрити.',
    recall: ['Коли це було: сьогодні, вчора, на початку тесту?', 'Де ти був/була і чим займався/лась перед цим?', 'Що підштовхнуло: повідомлення, цікавість, власна ідея, щось інше?'],
    specials: [['no_specific_case', "Не пам'ятаю конкретного випадку"]]
  },
  U2: {
    type: 'text', text: 'Яку конкретну дію ти тоді намагався/лася виконати?',
    eg: 'Приклад форми відповіді: одна дія, наприклад «хотів/ла переглянути стрічку» або «хотів/ла завантажити свою роботу».',
    recall: ['Що ти хотів/ла зробити в додатку?', 'З чого почав/ла?', 'Який екран чи кнопка були першими?'],
    specials: [['no_action', 'Просто відкрив/ла без конкретної дії'], ['dont_remember', SURVEY_DK]]
  },
  U3: {
    type: 'text', text: 'Чим закінчилася ця спроба?',
    eg: 'Приклад форми відповіді: «Вийшло», «Не вийшло, бо не знайшов/ла кнопку», «Кинув/ла, бо було незрозуміло».',
    recall: ['Ти досяг/ла того, що хотів/ла?', 'Якщо ні, що саме завадило?', 'Що ти зробив/ла наприкінці: закрив/ла додаток чи спробував/ла інакше?'],
    specials: [['dont_remember', SURVEY_DK]]
  },
  R1: {
    type: 'text', text: 'Згадай одне з повторних відкриттів Mimeon. Що безпосередньо передувало йому?',
    eg: 'Приклад форми відповіді: що сталося за хвилину чи годину до того, як ти відкрив/ла додаток.',
    recall: ['Коли це було?', 'Де ти був/була і що робив/ла перед цим?', 'Що підштовхнуло відкрити додаток знову?'],
    specials: [['dont_remember', SURVEY_DK]]
  },
  U4: {
    type: 'text', text: 'За цей період де, крім Mimeon, ти востаннє переглядав/ла або публікував/ла візуальні роботи?',
    note: SURVEY_NOTE_VISUAL,
    eg: 'Приклад форми відповіді: назва додатка чи сайту й що ти там робив/ла.',
    recall: ['Згадай останній раз, коли ти дивився/лась чиїсь роботи не в Mimeon.', 'Де це було?', 'Що ти там робив/ла: дивився/лась, зберігав/ла, публікував/ла?'],
    specials: [['no_case', 'Такого випадку не було'], ['dont_remember', SURVEY_DK]]
  },
  U5: {
    type: 'multi', text: 'Що з цього ти фактично робив/ла в Mimeon за час тесту?',
    note: 'Можна обрати кілька. Обирай лише те, що справді робив/ла.',
    options: [['view_feed', 'Переглядав/ла стрічку'], ['open_image', 'Відкривав/ла зображення'], ['publish', 'Публікував/ла своє зображення'], ['react', 'Ставив/ла реакцію'],
      ['comment', 'Залишав/ла коментар'], ['save_favorite', 'Зберігав/ла в обране'], ['return_saved', 'Повертався/лась до збереженого'], ['share_link', 'Ділився/лась посиланням'],
      ['nothing', 'Нічого з переліченого'], ['other', 'Інше'], ['unknown', SURVEY_DK]],
    exclusive: ['nothing', 'unknown']
  },
  P1: {
    type: 'text', text: 'Що ти зробив/ла зі своєю публікацією після її розміщення?',
    eg: 'Приклад форми відповіді: «Показав/ла комусь», «Заходив/ла перевірити реакції», «Нічого».',
    recall: ['Ти заходив/ла до неї ще раз?', 'Показував/ла її комусь?', 'Чи з\'явилися реакції чи коментарі і що ти з ними робив/ла?'],
    specials: [['nothing', 'Нічого'], ['dont_remember', SURVEY_DK]]
  },
  U6: {
    type: 'choice', text: 'Чи був під час тесту випадок, коли ти почав/ла якусь дію в Mimeon і не зміг/ла її завершити?',
    note: 'Наприклад: почав/ла публікацію, але не закінчив/ла; щось не завантажилося; не знайшов/ла потрібну кнопку.',
    options: [['yes', 'Так'], ['no', 'Ні'], ['unknown', SURVEY_DK]]
  },
  E1: {
    type: 'text', media: true, text: 'Згадай останній такий випадок. Що ти намагався/лася зробити?',
    eg: 'Приклад форми відповіді: одна дія, яку ти хотів/ла завершити.',
    recall: ['Коли це було?', 'З якого екрана ти починав/ла?', 'Що ти хотів/ла отримати наприкінці?'],
    specials: [['dont_remember', SURVEY_DK]]
  },
  E2: {
    type: 'text', media: true, text: 'Що фактично сталося на екрані?',
    eg: 'Приклад форми відповіді: що ти побачив/ла (текст помилки, порожній екран, зависання). Можна надіслати скриншот.',
    recall: ['Що з\'явилося на екрані після твоєї дії?', 'Чи був якийсь текст чи значок помилки?', 'Що ти зробив/ла у відповідь?'],
    specials: [['dont_remember', SURVEY_DK]]
  },
  // Додатковий блок «розкажи докладніше»: необов'язковий, не входить у основну анкету.
  W1: {
    type: 'text', media: true, text: 'Чого тобі не вистачало?',
    note: 'Згадай конкретну ситуацію: що ти хотів/ла знайти чи зробити в Mimeon, але не вдалося.',
    eg: 'Приклад форми відповіді: «Хотів/ла ..., але не знайшов/ла ...».',
    recall: ['Що ти намагався/лась знайти чи зробити?', 'Що ти очікував/ла побачити, а його не було?', 'Чого бракувало, щоб додаток був корисним саме тобі?'],
    specials: [['nothing', 'Всього вистачало'], ['dont_remember', SURVEY_DK]]
  },
  W2: {
    type: 'text', media: true, text: 'Що тобі заважало?',
    note: 'Що сповільнювало, дратувало чи заважало користуватися.',
    eg: 'Приклад форми відповіді: «Заважало ..., коли я ...».',
    recall: ['Що тебе сповільнило чи розчарувало?', 'Чи був момент, коли хотілося закрити додаток?', 'Що довелося повторювати кілька разів?'],
    specials: [['nothing', 'Нічого не заважало'], ['dont_remember', SURVEY_DK]]
  },
  W3: {
    type: 'text', media: true, text: 'Що було неочевидно або незрозуміло?',
    note: 'Де ти не знав/ла, що робити далі, або не зрозумів/ла значок чи жест.',
    eg: 'Приклад форми відповіді: «Не зрозумів/ла, що означає ..., бо очікував/ла ...».',
    recall: ['Де ти зупинявся/лась і думав/ла «а що тут робити?»', 'Який значок, жест чи кнопка були незрозумілі?', 'Що ти очікував/ла, а сталося інше?'],
    specials: [['nothing', 'Все було зрозуміло'], ['dont_remember', SURVEY_DK]]
  },
  W4: {
    type: 'text', media: true, text: 'Що сподобалося найбільше?',
    note: 'Чим конкретніше, тим краще: який екран, дія чи момент запам\'ятався.',
    eg: 'Приклад форми відповіді: «Сподобалося ..., бо ...».',
    recall: ['Яка дія чи екран залишили найкраще враження?', 'Що було приємним, швидким чи несподіваним?', 'Що ти б залишив/ла без змін?'],
    specials: [['nothing', 'Нічого особливого'], ['dont_remember', SURVEY_DK]]
  }
};
const SURVEY_W = ['W1', 'W2', 'W3', 'W4'];
const SURVEY_A_SEQ = ['A1', 'A2', 'A3', 'A4'];
const SURVEY_STALE_GRACE_MS = 5000;

// ---------- Таблиці ----------
function surveys_() {
  const t = table_('SURVEYS');
  if (!t.loaded) t.load(3);
  return t;
}
function answers_() {
  const t = table_('ANSWERS');
  if (!t.loaded) t.load(3);
  return t;
}
function surveyOf_(participantId) {
  // остання за часом початку анкета учасника
  const all = surveys_().filter(function (s) { return s.participant_id === participantId; });
  if (!all.length) return null;
  return all.sort(function (a, b) { return (parseIso_(b.started_at) || 0) - (parseIso_(a.started_at) || 0); })[0];
}
function surveyIsCompleted_(participantId) {
  return !!surveys_().find(function (s) { return s.participant_id === participantId && s.status === 'completed'; });
}
/** Автоматичний збір завершено: незавершена анкета -> collection_closed; відповіді залишаються. */
function surveyCloseCollection_(p) {
  const S = settings_();
  const t = surveys_();
  const s = surveyOf_(p.participant_id);
  if (s && s.status === 'completed') return s;
  if (s && s.completed_at) { const back = surveyRestoreCompleted_(s); if (back.status === 'completed') return back; }
  if (!s) {
    const created = t.append({
      survey_id: surveyIdFor_(p.participant_id), participant_id: p.participant_id,
      survey_version: S.SURVEY_VERSION, status: 'collection_closed', branch: null,
      current_question_id: null, current_prompt_message_id: null, started_at: null, last_answer_at: null, completed_at: null,
      last_period_start: p.trial_started_at, last_period_end: p.trial_end_at, branch_revision: 0, paused_by_support: false, analyst_notes: null
    });
    // branch не вигадуємо: це лише факт закриття збору без жодної відповіді
    participants_().update(p, { active_survey_id: created.survey_id });
    return created;
  }
  if (s.status !== 'collection_closed') t.update(s, { status: 'collection_closed' });
  return s;
}

// ---------- Ідентифікатори ----------
function surveyIdFor_(participantId) { return 'sv_' + sha256Hex_('survey|' + participantId).slice(0, 12); }
function answerIdFor_(eventId, qid) { return 'ans_' + sha256Hex_('ans|' + eventId + '|' + qid).slice(0, 16); }

// ---------- Фідбек і право на подяку ----------
/** Встановлює feedback_received/first/latest (ідемпотентно) і право на подяку. */
function markFeedback_(participantId, atIso, srcType, srcId) {
  const pt = participants_();
  const p = pt.get(participantId);
  if (!p) return;
  const patch = {};
  if (p.feedback_received !== true) patch.feedback_received = true;
  if (!p.first_feedback_at) patch.first_feedback_at = atIso;
  const lastMs = parseIso_(p.latest_feedback_at);
  if (lastMs === null || (parseIso_(atIso) || 0) > lastMs) patch.latest_feedback_at = atIso;
  if (Object.keys(patch).length) pt.update(p, patch);
  if (typeof ensureRewardEligibility_ === 'function') ensureRewardEligibility_(p, srcType, srcId, atIso);
}

// ---------- Поточні відповіді, план, гілка ----------
function surveyParseAnswer_(a) {
  const j = safeJsonParse_(a.answer_enum_or_json, {}) || {};
  return { row: a, format: a.answer_format, code: j.code || null, codes: j.codes || null, text: a.answer_text, qid: a.question_id };
}
function surveyCurrentAnswers_(sv) {
  const cur = {};
  answers_().filter(function (a) { return a.survey_id === sv.survey_id && a.is_current === true; }).forEach(function (a) { cur[a.question_id] = surveyParseAnswer_(a); });
  return cur;
}
function surveyCodeOf_(a) {
  if (!a) return null;
  if (a.format === 'skipped') return 'skipped';
  return a.code;
}
function surveyIsReal_(a) { return !!a && (a.format === 'text' || a.format === 'media' || a.format === 'text_media'); }

/** План питань за поточними відповідями. Питання без потрібних попередніх відповідей у план не потрапляють. */
function surveyPlanBase_(cur) {
  const g1 = surveyCodeOf_(cur.G1), g2 = surveyCodeOf_(cur.G2);
  if (g1 === null) return { plan: ['G1'], branch: null };
  if (g1 === 'not_installed') return { plan: ['G1'].concat(SURVEY_A_SEQ), branch: 'not_started_experience' };
  const base = ['G1', 'G2'];
  if (g2 === null) return { plan: base, branch: null };
  const tail = function (withR) {
    const seq = ['U1', 'U2', 'U3'];
    if (withR) seq.push('R1');
    seq.push('U4', 'U5');
    if (cur.U5 && cur.U5.codes && cur.U5.codes.indexOf('publish') >= 0) seq.push('P1');
    seq.push('U6');
    if (surveyCodeOf_(cur.U6) === 'yes') seq.push('E1', 'E2');
    return seq;
  };
  if (g2 === 'days_0') return { plan: base.concat(SURVEY_A_SEQ), branch: 'not_started_experience' };
  if (g2 === 'days_1') return { plan: base.concat(tail(false)), branch: 'one_day' };
  if (g2 === 'days_2_3' || g2 === 'days_4_7' || g2 === 'days_8_plus') return { plan: base.concat(tail(true)), branch: 'multiple_days' };
  // G2 невідомо або пропущено
  const g1Unknown = (g1 === 'unknown' || g1 === 'skipped');
  if (g1Unknown && surveyCodeOf_(cur.U1) === 'no_specific_case') return { plan: base.concat(['U1'], SURVEY_A_SEQ), branch: 'unknown_experience' };
  return { plan: base.concat(tail(false)), branch: 'unknown_experience' };
}

/** План + необов'язковий додатковий блок W (лише для тих, хто його розпочав і хто користувався додатком). */
function surveyPlan_(cur) {
  const r = surveyPlanBase_(cur);
  if (cur.W1 && r.branch && r.branch !== 'not_started_experience') r.plan = r.plan.concat(SURVEY_W);
  return r;
}

/** Перераховує гілку й позначки актуальності. Історію не видаляє. Повертає {plan, branch, next}. */
function surveyRecompute_(sv) {
  const cur = surveyCurrentAnswers_(sv);
  const pl = surveyPlan_(cur);
  let next = null, nextRequired = null;
  for (let i = 0; i < pl.plan.length; i++) {
    if (cur[pl.plan[i]]) continue;
    if (next === null) next = pl.plan[i];
    if (SURVEY_W.indexOf(pl.plan[i]) < 0) { nextRequired = pl.plan[i]; break; }
  }
  const planSet = {};
  pl.plan.forEach(function (q) { planSet[q] = true; });
  answers_().filter(function (a) { return a.survey_id === sv.survey_id; }).forEach(function (a) {
    const want = !!planSet[a.question_id];
    if (a.applies_to_current_branch !== want) answers_().update(a, { applies_to_current_branch: want });
  });
  const patch = {};
  if (pl.branch !== null && sv.branch !== pl.branch) {
    patch.branch = pl.branch;
    if (sv.branch) patch.branch_revision = (sv.branch_revision || 0) + 1;
    else if (!sv.branch_revision) patch.branch_revision = 1;
  }
  if (Object.keys(patch).length) surveys_().update(sv, patch);
  return { plan: pl.plan, branch: pl.branch, next: next, nextRequired: nextRequired, cur: cur };
}

// ---------- Створення й відновлення ----------
function surveyStart_(p, S, nowMs) {
  let sv = surveyOf_(p.participant_id);
  const startMs = parseIso_(p.trial_started_at);
  const endMs = Math.min(parseIso_(p.trial_end_at) || nowMs, nowMs);
  if (!sv) {
    sv = surveys_().append({
      survey_id: surveyIdFor_(p.participant_id), participant_id: p.participant_id, survey_version: S.SURVEY_VERSION, status: 'in_progress', branch: null,
      current_question_id: null, current_prompt_message_id: null, started_at: isoSec_(nowMs), last_answer_at: null, completed_at: null,
      last_period_start: isoSec_(startMs), last_period_end: isoSec_(endMs), branch_revision: 0, paused_by_support: false, analyst_notes: null
    });
  } else if (!sv.started_at) {
    sv = surveys_().update(sv, { status: 'in_progress', started_at: isoSec_(nowMs), last_period_start: isoSec_(startMs), last_period_end: isoSec_(endMs), paused_by_support: false });
  } else if (sv.status !== 'in_progress' && sv.status !== 'completed') {
    sv = surveys_().update(sv, { status: 'in_progress', paused_by_support: false });
  }
  return sv;
}

function surveyPeriodLine_(sv, S) {
  const a = parseIso_(sv.last_period_start), b = parseIso_(sv.last_period_end);
  if (a === null || b === null) return '';
  return 'Період тесту: ' + localDateDots_(a, S.TIMEZONE) + ' — ' + localDateDots_(b, S.TIMEZONE);
}

/** Питання з багатьма/довгими варіантами показуємо нумерованим списком: кнопки-номери компактні й вміщуються на екрані. */
function surveyNumbered_(q) {
  if (q.type === 'multi') return true;
  if (q.type !== 'choice') return false;
  return packRows_(q.options.map(function (o) { return o[1]; })).length > 3;
}
function surveyHasHelp_(q) { return !!(q.recall && q.recall.length); }
function packNums_(labels) { return packRows_(labels, 6, 80); }

function surveyKb_(qid, ctx) {
  const q = SURVEY_Q[qid];
  const rows = [];
  if (q.type === 'multi') {
    const sel = ctx.sel || [];
    packNums_(q.options.map(function (o, i) { return (sel.indexOf(o[0]) >= 0 ? '✓ ' : '') + (i + 1); })).forEach(function (r) { rows.push(r); });
  } else if (q.type === 'choice') {
    if (surveyNumbered_(q)) packNums_(q.options.map(function (o, i) { return String(i + 1); })).forEach(function (r) { rows.push(r); });
    else packRows_(q.options.map(function (o) { return o[1]; })).forEach(function (r) { rows.push(r); });
  } else {
    const sp = q.specials.map(function (o) { return o[1]; });
    if (surveyHasHelp_(q)) sp.push(BTN.SURVEY_HELP);
    packRows_(sp).forEach(function (r) { rows.push(r); });
  }
  const ctl = [];
  if (qid !== 'G1') ctl.push(BTN.BACK);
  ctl.push(BTN.SURVEY_SKIP, BTN.SURVEY_LATER);
  rows.push(ctl);
  // «Готово» — останній рядок: це завершальна дія. Усього рядків не більше 4, тож його видно без прокрутки (перевіряє тест 180)
  if (q.type === 'multi') rows.push([BTN.DONE, BTN.SURVEY_RESET]);
  return kbReply_(rows, { placeholder: q.type === 'text' ? 'Напиши відповідь або обери кнопку' : undefined });
}

function surveyOptionsList_(q) {
  return q.options.map(function (o, i) { return (i + 1) + '. ' + o[1]; }).join('\n');
}

function surveyPromptText_(sv, qid, S) {
  const q = SURVEY_Q[qid];
  const numbered = surveyNumbered_(q);
  const hint = q.type === 'choice' ? (numbered ? 'Натисни номер варіанта.' : 'Обери варіант кнопкою.')
    : (q.type === 'multi' ? 'Натискай номери, потім «Готово».'
      : 'Напиши відповідь своїми словами' + (q.media ? ' (можна додати фото, скриншот чи голосове)' : '') + ' або обери готову відповідь.' + (surveyHasHelp_(q) ? ' Не знаєш, з чого почати? Натисни «Допоможи згадати».' : ''));
  return [surveyPeriodLine_(sv, S), q.text, q.note, numbered ? surveyOptionsList_(q) : null, q.eg, hint].filter(Boolean).join('\n\n');
}

function surveyHelpText_(qid) {
  const q = SURVEY_Q[qid];
  const lines = ['Допоможу згадати. Дай відповідь на будь-які з цих питань, усі не обов\'язкові:'];
  (q.recall || []).forEach(function (r) { lines.push('• ' + r); });
  lines.push('Потім напиши все одним повідомленням. Можна коротко й неточно: це нормально.');
  return lines.join('\n');
}

/** Ставить питання: стан діалогу (фіксується в оновленні учасника), дзеркало в "Опитування", повідомлення з hook для message_id. */
function surveyAsk_(t, sv, qid, tag, extraSel) {
  const ctx = { q: qid, sel: extraSel || [], prompt_ms: null };
  const patch = { current_question_id: qid, current_prompt_message_id: null };
  // Повтор події після збою: питання вже могло бути доставлене (і хук доставки відпрацював раніше за цей запис).
  const key = t.p.participant_id + ':' + t.ev.event_id + ':' + (tag || 'q');
  if (outboxKeys_()[key]) {
    const sentJob = outbox_().find(function (j) { return j.idempotency_key === key || String(j.idempotency_key).indexOf(key + '#p') === 0; });
    if (sentJob && sentJob.status === 'sent') { ctx.prompt_ms = parseIso_(sentJob.sent_at) || null; patch.current_prompt_message_id = sentJob.telegram_message_id || null; }
  }
  t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_(ctx), active_survey_id: sv.survey_id });
  if (sv.status !== 'in_progress') { patch.status = 'in_progress'; patch.paused_by_support = false; }
  surveys_().update(sv, patch);
  t.say(tag || 'q', surveyPromptText_(sv, qid, t.S), surveyKb_(qid, ctx), { kind: 'survey_question', meta: { survey_id: sv.survey_id, question_id: qid } });
}

/** Післядія доставки питання: зберігаємо message_id (для зіставлення відповідей) і час доставки. */
function onSurveyPromptSent_(job) {
  const meta = (safeJsonParse_(job.payload_json, {}) || {}).meta || {};
  if (!meta.survey_id) return;
  const sv = surveys_().get(meta.survey_id);
  if (!sv || sv.status === 'completed') return;
  if (sv.current_question_id === meta.question_id && toText_(sv.current_prompt_message_id) !== toText_(job.telegram_message_id)) {
    surveys_().update(sv, { current_prompt_message_id: job.telegram_message_id || null });
  }
  const p = participants_().get(job.participant_id);
  if (p && p.dialog_type === 'survey_question') {
    const ctx = dialogCtx_(p);
    if (ctx.q === meta.question_id) {
      ctx.prompt_ms = parseIso_(job.sent_at) || nowMs_();
      participants_().update(p, { dialog_context_json: jsonStr_(ctx) });
    }
  }
}

// ---------- Вхід із меню ----------
function onMenuFeedback_(t) {
  const p = t.p, S = t.S;
  if (!p.trial_started_at) { t.say('sv_na', renderTemplate_('survey_not_available')); return true; }
  let existing = surveyOf_(p.participant_id);
  if (existing && existing.completed_at) existing = surveyRestoreCompleted_(existing);   // перервана зміна відповідей = знову завершена
  if (existing && existing.status === 'completed') { fbMenu_(t, existing); return true; }
  existing = surveyOf_(p.participant_id);
  const fresh = !existing || !existing.started_at;
  const sv = surveyStart_(p, S, t.now);
  const r = surveyRecompute_(sv);
  let q = (sv.current_question_id && r.plan.indexOf(sv.current_question_id) >= 0 && !r.cur[sv.current_question_id]) ? sv.current_question_id : r.next;
  if (!q) { surveyComplete_(t, sv); return true; }
  t.say('lead', renderTemplate_(fresh ? 'survey_intro' : 'survey_resume'), null);
  surveyAsk_(t, sv, q, 'q');
  return true;
}

/** Меню/команда в анкеті. critical — критичне звернення призупиняє анкету (вона відновиться з того самого питання). */
function surveyInterrupt_(t, critical) {
  const p = t.p;
  t.set(clearDialogPatch_());
  let sv = surveyOf_(p.participant_id);
  if (sv) sv = surveyRestoreCompleted_(sv);
  if (sv && sv.status !== 'completed' && critical && sv.started_at) surveys_().update(sv, { status: 'paused', paused_by_support: true });
}
function surveyMenuInterrupt_(text) {
  return isMenuInput_(text) && !btnIs_(text, BTN.BACK) && !btnIs_(text, BTN.GIVE_FEEDBACK) && !btnIs_(text, BTN.MENU_FEEDBACK);
}
/** Нагадування учаснику, що анкета призупинена (після завершення звернення). */
function surveyResumeHint_(t) {
  const sv = surveyOf_(t.p.participant_id);
  if (sv && sv.status === 'paused' && sv.paused_by_support === true) t.say('survey_hint', renderTemplate_('survey_resume_hint'), null);
}

/** Обробка команд і кнопок, які не є відповіддю. true — хід повністю оброблено. */
function surveyBeforeRoute_(t, text, cmd) {
  const p = t.p;
  if (cmd) {
    if (cmd.name === 'cancel') { surveyLater_(t); return true; }
    if (cmd.name === 'start' || cmd.name === 'feedback') { onMenuFeedback_(t); return true; }
    surveyInterrupt_(t, cmd.name === 'critical');
    return false;
  }
  if (btnIs_(text, BTN.MENU_FEEDBACK)) { onMenuFeedback_(t); return true; }
  if (surveyMenuInterrupt_(text)) { surveyInterrupt_(t, btnIs_(text, BTN.MENU_CRITICAL)); return false; }
  return null;
}

function surveyLater_(t) {
  t.set(clearDialogPatch_());
  const sv0 = surveyOf_(t.p.participant_id);
  const sv = sv0 ? surveyRestoreCompleted_(sv0) : null;
  if (sv && sv.completed_at && sv.status === 'completed') { t.say('later', renderTemplate_('fb_closed'), mainMenuKb_()); return; }
  t.say('later', renderTemplate_('survey_later'), mainMenuKb_());
}

// ---------- Збереження відповіді ----------
function surveyAnswerText_(qid, ans) {
  if (!ans) return '';
  if (ans.format === 'skipped') return '(пропущено)';
  return ans.text || '';
}

/** Ідемпотентно зберігає відповідь (нова ревізія; попередня актуальна стає is_current=false). */
function surveySaveAnswer_(t, sv, qid, a) {
  const id = answerIdFor_(t.ev.event_id, qid);
  const exist = answers_().get(id);
  if (exist) return exist;
  const prior = answers_().filter(function (x) { return x.survey_id === sv.survey_id && x.question_id === qid; });
  let rev = 0;
  prior.forEach(function (x) { rev = Math.max(rev, x.answer_revision || 0); if (x.is_current === true) answers_().update(x, { is_current: false }); });
  const m = t.pl.message;
  const ms = Math.min(m.date ? m.date * 1000 : t.now, t.now);
  const row = answers_().append({
    answer_id: id, survey_id: sv.survey_id, participant_id: t.p.participant_id, question_id: qid, survey_version: sv.survey_version,
    question_text_snapshot: SURVEY_Q[qid].text, answer_format: a.format,
    answer_enum_or_json: a.json === undefined ? null : JSON.stringify(a.json), answer_text: a.text === undefined ? null : a.text,
    attachment_ids: a.attachmentIds || null, answered_at: isoSec_(ms), source_update_id: toText_(t.ev.update_id), telegram_message_id: toText_(m.message_id),
    answer_revision: rev + 1, is_current: true, applies_to_current_branch: true, evidence_label: 'unreviewed', analyst_note: null
  });
  surveys_().update(sv, { last_answer_at: isoSec_(ms), status: sv.status === 'collection_closed' ? 'in_progress' : sv.status });
  if (a.format !== 'skipped') markFeedback_(t.p.participant_id, isoSec_(ms), 'survey_answer', id);
  return row;
}

/** Після збереження: наступне питання або завершення. */
function surveyAdvance_(t, sv) {
  const r = surveyRecompute_(sv);
  if (!r.next) { surveyComplete_(t, sv); return; }
  surveyAsk_(t, sv, r.next, 'q');
}

// ---------- Завершення й передача в підтримку ----------
function surveyHandoffSource_(sv) {
  const cur = surveyCurrentAnswers_(sv);
  const r = surveyPlan_(cur);
  const labelOf = function (qid, a) {
    if (!a) return null;
    if (a.format === 'skipped') return null;
    return a.text;
  };
  const att = [];
  const addAtt = function (a) { if (a && a.row.attachment_ids) parseIdList_(a.row.attachment_ids).forEach(function (x) { att.push(x); }); };
  if (r.plan.indexOf('A2') >= 0) {
    if (!surveyIsReal_(cur.A2)) return null;
    addAtt(cur.A2);
    const lines = ['Опис із анкети (не вдалося почати).'];
    if (labelOf('A1', cur.A1)) lines.push('Етап: ' + labelOf('A1', cur.A1));
    lines.push('Що відбулося: ' + (cur.A2.text || '[вкладення]'));
    if (labelOf('A3', cur.A3)) lines.push('Що зробив/ла після цього: ' + labelOf('A3', cur.A3));
    return { text: lines.join('\n'), attachmentIds: att };
  }
  if (r.plan.indexOf('E1') >= 0) {
    if (!surveyIsReal_(cur.E1) && !surveyIsReal_(cur.E2)) return null;
    addAtt(cur.E1); addAtt(cur.E2);
    const lines = ['Опис із анкети (дія, яку не вдалося завершити).'];
    if (surveyIsReal_(cur.E1)) lines.push('Що намагався/лася зробити: ' + (cur.E1.text || '[вкладення]'));
    if (surveyIsReal_(cur.E2)) lines.push('Що сталося на екрані: ' + (cur.E2.text || '[вкладення]'));
    return { text: lines.join('\n'), attachmentIds: att };
  }
  return null;
}

function surveyComplete_(t, sv) {
  const p = t.p;
  const nowIso = isoSec_(t.now);
  surveys_().update(sv, { status: 'completed', completed_at: sv.completed_at || nowIso, current_question_id: null, current_prompt_message_id: null, paused_by_support: false });
  const fresh = participants_().get(p.participant_id) || p;
  const hasFeedback = fresh.feedback_received === true;
  const cur = surveyCurrentAnswers_(sv);
  if (cur.W1) {                                          // завершено додатковий блок: без повторної пропозиції передати опис
    t.set(Object.assign(clearDialogPatch_(), { active_survey_id: sv.survey_id }));
    t.say('done', renderTemplate_('survey_extra_done'), mainMenuKb_());
    return;
  }
  const offer = surveyHandoffSource_(sv);
  const body = renderTemplate_(hasFeedback ? 'survey_done' : 'survey_done_no_feedback') + '\n\n' + renderTemplate_('fb_later_hint');
  if (!offer && surveyExtraAvailable_(sv)) {             // пропонуємо додаткові 4 питання, одразу після основної анкети
    t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_({ q: 'EXTRA_OFFER' }), active_survey_id: sv.survey_id });
    t.say('done', body + '\n\n' + renderTemplate_('survey_extra_offer'), kbReply_([[BTN.EXTRA_YES], [BTN.EXTRA_NO]], { oneTime: true }));
    return;
  }
  if (offer) {
    t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_({ q: 'HANDOFF' }), active_survey_id: sv.survey_id });
    t.say('done', body + '\n\n' + renderTemplate_('survey_handoff_offer'), kbReply_([[BTN.HANDOFF], [BTN.HANDOFF_CRITICAL], [BTN.HANDOFF_NO]], { oneTime: true }));
  } else {
    t.set(Object.assign(clearDialogPatch_(), { active_survey_id: sv.survey_id }));
    t.say('done', body, mainMenuKb_());
  }
}

function surveyHandoff_(t, sv) {
  const p = t.p, S = t.S;
  const text = normText_(t.pl.message.text);
  const critical = btnIs_(text, BTN.HANDOFF_CRITICAL);
  if (btnIs_(text, BTN.HANDOFF_NO)) {
    t.set(clearDialogPatch_());
    t.say('handoff_no', renderTemplate_('survey_handoff_declined'), mainMenuKb_());
    return true;
  }
  if (!critical && !btnIs_(text, BTN.HANDOFF)) {
    // інше повідомлення: забуваємо пропозицію й обробляємо як звичайне вільне повідомлення
    t.set(clearDialogPatch_());
    return onFreeMessage_(t);
  }
  const src = surveyHandoffSource_(sv);
  if (!src) { t.set(clearDialogPatch_()); t.say('handoff_none', renderTemplate_('survey_handoff_declined'), mainMenuKb_()); return true; }
  const msgId = msgIdFor_(t.ev.event_id);
  let msg = messages_().get(msgId);
  if (!msg) {
    msg = messages_().append({
      message_record_id: msgId, participant_id: p.participant_id, ticket_id: null, survey_id: sv.survey_id, direction: 'in', author_type: 'participant',
      source_update_id: toText_(t.ev.update_id), telegram_message_id: toText_(t.pl.message.message_id), reply_to_message_id: null,
      created_at: isoSec_(t.now), body_text: src.text, attachment_ids: src.attachmentIds.join(',') || null, media_group_id: null, related_reply_id: null
    });
  }
  const tk = createTicketFromMessage_(t, msg, critical);
  t.set(clearDialogPatch_());
  t.say('handoff', renderTemplate_(critical ? 'critical_saved' : 'support_saved', { ticket_id: tk.ticket_id, hours: String(S.SUPPORT_FIRST_RESPONSE_HOURS) }), mainMenuKb_());
  return true;
}

// ---------- Розбір відповіді ----------
function surveyStash_(t, sv) {
  const info = incomingInfo_(t);
  const msg = recordIncoming_(t, info, null);
  if (msg.survey_id !== sv.survey_id) messages_().update(msg, { survey_id: sv.survey_id });
  tooLargeNotice_(t, info);
  return msg;
}

/** Причина, через яку повідомлення не можна зарахувати поточному питанню; null — можна. */
function surveyStaleReason_(t, sv, ctx) {
  const m = t.pl.message;
  if (m.reply_to_message_id) {
    const chat = toText_(t.p.chat_id);
    const job = outbox_().find(function (j) {
      return j.message_kind === 'survey_question' && toText_(j.recipient_chat_id) === chat && toText_(j.telegram_message_id) === toText_(m.reply_to_message_id);
    });
    if (job) {
      const meta = (safeJsonParse_(job.payload_json, {}) || {}).meta || {};
      if (meta.question_id !== ctx.q) return 'old_prompt';
    }
  }
  if (!sv.current_prompt_message_id) return 'prompt_not_delivered';
  if (ctx.prompt_ms && m.date && m.date * 1000 < ctx.prompt_ms - SURVEY_STALE_GRACE_MS) return 'before_prompt';
  return null;
}

function surveySelLabels_(qid, sel) {
  const q = SURVEY_Q[qid];
  return sel.map(function (c) { const o = q.options.filter(function (x) { return x[0] === c; })[0]; return o ? o[1] : c; }).join(', ');
}

function onDialogMessageSurvey_(t) {
  const p = t.p, S = t.S;
  const sv = surveys_().get(p.dialog_ref_id) || surveyOf_(p.participant_id);
  const ctx = dialogCtx_(p);
  if (!sv) { t.set(clearDialogPatch_()); return onFreeMessage_(t); }
  if (ctx.q === 'HANDOFF') return surveyHandoff_(t, sv);
  if (ctx.q === 'FB_MENU' || ctx.q === 'FB_PICK' || ctx.q === 'FB_NOTE') return fbDialog_(t, sv, ctx);
  if (ctx.q === 'EXTRA_OFFER') return surveyExtraOffer_(t, sv);
  if (sv.status === 'completed') { fbMenu_(t, sv); return true; }
  const qid = ctx.q;
  const q = SURVEY_Q[qid];
  if (!q) {                                           // пошкоджений контекст: безпечно повертаємо актуальне питання
    const r = surveyRecompute_(sv);
    if (!r.next) { surveyComplete_(t, sv); return true; }
    surveyAsk_(t, sv, r.next, 'q');
    return true;
  }
  const m = t.pl.message;
  const rawText = toText_((m.text !== null && m.text !== undefined) ? m.text : m.caption).trim();
  const text = normText_(rawText);
  const atts = m.attachments || [];
  const isButtonText = m.text !== null && m.text !== undefined && !atts.length;

  // 1) службові кнопки
  if (isButtonText && btnIs_(text, BTN.SURVEY_LATER)) { surveyLater_(t); return true; }
  if (isButtonText && btnIs_(text, BTN.BACK)) return surveyBack_(t, sv, qid);
  if (isButtonText && btnIs_(text, BTN.SURVEY_HELP)) {
    t.say('help', surveyHelpText_(qid), surveyKb_(qid, ctx), { kind: 'survey_notice' });
    return true;
  }
  // альбом: наступні елементи того самого media_group_id додаються до тієї ж відповіді
  if (m.media_group_id) {
    const sib = answers_().find(function (a) {
      return a.survey_id === sv.survey_id && a.participant_id === p.participant_id && a.is_current === true && a.source_update_id !== toText_(t.ev.update_id) &&
        messages_().find(function (x) { return x.media_group_id === toText_(m.media_group_id) && x.participant_id === p.participant_id && x.telegram_message_id === a.telegram_message_id; });
    });
    if (sib) {
      const info = incomingInfo_(t);
      const msg = recordIncoming_(t, info, null);
      if (msg.survey_id !== sv.survey_id) messages_().update(msg, { survey_id: sv.survey_id });
      const ids = parseIdList_(sib.attachment_ids).concat(parseIdList_(msg.attachment_ids));
      const uniq = ids.filter(function (x, i) { return ids.indexOf(x) === i; }).join(',');
      if (uniq !== toText_(sib.attachment_ids)) answers_().update(sib, { attachment_ids: uniq || null, answer_format: 'media' === sib.answer_format || !sib.answer_text ? 'media' : 'text_media' });
      tooLargeNotice_(t, info);
      return true;                                    // без нового питання й повідомлення: це продовження альбому
    }
  }
  const stale = surveyStaleReason_(t, sv, ctx);
  if (isButtonText && btnIs_(text, BTN.SURVEY_SKIP)) {
    if (stale === 'before_prompt' || stale === 'old_prompt') { surveyStash_(t, sv); t.say('clarify', renderTemplate_('survey_clarify'), null); return true; }
    surveySaveAnswer_(t, sv, qid, { format: 'skipped', json: { code: 'skipped' }, text: null });
    surveyAdvance_(t, sv);
    return true;
  }

  // 2) multi
  if (q.type === 'multi') return surveyMulti_(t, sv, qid, q, ctx, text, isButtonText, stale);

  // 3) готові відповіді
  let hit = null;
  if (isButtonText) {
    const list = q.type === 'choice' ? q.options : q.specials;
    list.forEach(function (o) { if (btnIs_(text, o[1])) hit = o; });
    if (!hit && q.type === 'choice' && surveyNumbered_(q)) {
      const mm = text.match(/^(\d{1,2})$/);
      if (mm) hit = q.options[parseInt(mm[1], 10) - 1] || null;
    }
  }
  if (hit) {
    if (stale === 'before_prompt' || stale === 'old_prompt' || stale === 'prompt_not_delivered') { surveyStash_(t, sv); t.say('clarify', renderTemplate_('survey_clarify'), null); return true; }
    surveySaveAnswer_(t, sv, qid, { format: q.type === 'choice' ? 'choice' : 'special', json: { code: hit[0] }, text: hit[1] });
    surveyAdvance_(t, sv);
    return true;
  }

  // 4) вільна відповідь
  if (!rawText && !atts.length) { t.say('empty', surveyPromptText_(sv, qid, S), surveyKb_(qid, ctx), { kind: 'survey_notice' }); return true; }
  if (q.type === 'choice') {                          // на питання з кнопками написали текст: зберігаємо й уточнюємо
    surveyStash_(t, sv);
    t.say('hint', renderTemplate_('survey_choose_hint'), surveyKb_(qid, ctx), { kind: 'survey_notice' });
    return true;
  }
  if (stale) { surveyStash_(t, sv); t.say('clarify', renderTemplate_('survey_clarify'), null); return true; }
  let attachmentIds = null;
  if (atts.length) {
    const info = incomingInfo_(t);
    const msg = recordIncoming_(t, info, null);
    if (msg.survey_id !== sv.survey_id) messages_().update(msg, { survey_id: sv.survey_id });
    attachmentIds = msg.attachment_ids || null;
    tooLargeNotice_(t, info);
  }
  surveySaveAnswer_(t, sv, qid, { format: atts.length ? (rawText ? 'text_media' : 'media') : 'text', text: rawText || null, attachmentIds: attachmentIds });
  surveyAdvance_(t, sv);
  return true;
}

// ---------- Після завершення: змінити відповіді або додати новий фідбек ----------
/** Якщо анкета вже була завершена, а зміну відповідей перервали й непройдених питань немає — повертає статус completed. Повертає актуальний рядок. */
function surveyRestoreCompleted_(sv) {
  if (!sv || !sv.completed_at || sv.status === 'completed' || sv.status === 'collection_closed') return sv;
  const r = surveyRecompute_(sv);
  if (r.nextRequired) return sv;                       // додатковий блок W не робить анкету незавершеною
  return surveys_().update(sv, { status: 'completed', current_question_id: null, current_prompt_message_id: null, paused_by_support: false });
}

/** Покинута зміна відповідей (учасник нічого не натискав 30+ хв): завершена раніше анкета знову стає completed. */
function surveyRestoreStale_(S) {
  const now = nowMs_();
  surveys_().filter(function (sv) { return sv.completed_at && (sv.status === 'in_progress' || sv.status === 'paused'); }).forEach(function (sv) {
    const p = participants_().get(sv.participant_id);
    const seen = p ? parseIso_(p.last_seen_at) : null;
    if (p && seen !== null && now - seen < 30 * 60000) return;
    surveyRestoreCompleted_(sv);
  });
}

/** Чи можна запропонувати додатковий блок: користувався додатком і ще не відповідав на W1. */
function surveyExtraAvailable_(sv) {
  const r = surveyRecompute_(sv);
  return !!r.branch && r.branch !== 'not_started_experience' && !r.cur.W1;
}
function surveyExtraStart_(t, sv) {
  t.say('lead', renderTemplate_('survey_extra_intro'), null);
  surveyAsk_(t, sv, 'W1', 'q');
}
function surveyExtraOffer_(t, sv) {
  const text = normText_(t.pl.message.text);
  if (btnIs_(text, BTN.EXTRA_YES)) { surveyExtraStart_(t, sv); return true; }
  if (btnIs_(text, BTN.EXTRA_NO)) { t.set(clearDialogPatch_()); t.say('extra_no', renderTemplate_('survey_extra_declined'), mainMenuKb_()); return true; }
  t.set(clearDialogPatch_());                           // інше повідомлення: пропозицію забуваємо й обробляємо як звичайне
  return onFreeMessage_(t);
}

function fbMenuKb_(sv) {
  const rows = [[BTN.FB_CHANGE], [BTN.FB_ADD]];
  if (surveyExtraAvailable_(sv)) rows.push([BTN.FB_EXTRA]);
  rows.push([BTN.BACK]);
  return kbReply_(rows);
}
function fbMenu_(t, sv) {
  t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_({ q: 'FB_MENU' }), active_survey_id: sv.survey_id });
  t.say('fb_menu', renderTemplate_('fb_menu'), fbMenuKb_(sv));
}

function fbShort_(s, n) {
  const x = toText_(s).replace(/\s+/g, ' ').trim();
  return x.length > n ? x.slice(0, n - 1) + '…' : x;
}
function fbPick_(t, sv) {
  const r = surveyRecompute_(sv);
  const lines = [];
  const nums = [];
  r.plan.forEach(function (qid, i) {
    const a = r.cur[qid];
    const ans = a ? (surveyAnswerText_(qid, a) || (a.row.attachment_ids ? '[вкладення]' : '—')) : '—';
    lines.push((i + 1) + '. ' + fbShort_(SURVEY_Q[qid].text, 70) + '\n   → ' + fbShort_(ans, 80));
    nums.push(String(i + 1));
  });
  const rows = [];
  for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  rows.push([BTN.BACK]);
  t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_({ q: 'FB_PICK' }), active_survey_id: sv.survey_id });
  t.say('fb_pick', renderTemplate_('fb_pick', { list: lines.join('\n\n') }), kbReply_(rows));
}

function fbFinish_(t, text, tag) {
  t.set(clearDialogPatch_());
  t.say(tag, text, mainMenuKb_());
}

function fbDialog_(t, sv, ctx) {
  const m = t.pl.message;
  const hasText = m.text !== null && m.text !== undefined;
  const atts = m.attachments || [];
  const text = hasText ? normText_(m.text) : '';
  const isBtn = hasText && !atts.length;
  if (ctx.q === 'FB_MENU') {
    if (isBtn && btnIs_(text, BTN.BACK)) { fbFinish_(t, renderTemplate_('fb_closed'), 'fb_closed'); return true; }
    if (isBtn && btnIs_(text, BTN.FB_CHANGE)) { fbPick_(t, sv); return true; }
    if (isBtn && btnIs_(text, BTN.FB_ADD)) {
      t.set({ dialog_type: 'survey_question', dialog_ref_id: sv.survey_id, dialog_context_json: jsonStr_({ q: 'FB_NOTE', n: 0 }), active_survey_id: sv.survey_id });
      t.say('fb_add', renderTemplate_('fb_add_prompt'), kbReply_([[BTN.DONE], [BTN.CANCEL]]));
      return true;
    }
    if (isBtn && btnIs_(text, BTN.FB_EXTRA)) { surveyExtraStart_(t, sv); return true; }
    t.say('fb_menu', renderTemplate_('fb_menu'), fbMenuKb_(sv));
    return true;
  }
  if (ctx.q === 'FB_PICK') {
    if (isBtn && btnIs_(text, BTN.BACK)) { fbMenu_(t, sv); return true; }
    const mm = isBtn ? text.match(/^(\d{1,2})$/) : null;
    const r = surveyRecompute_(sv);
    const qid = mm ? r.plan[parseInt(mm[1], 10) - 1] : null;
    if (!qid) { t.say('fb_pick_unknown', renderTemplate_('fb_pick_unknown')); return true; }
    const a = r.cur[qid];
    if (a) t.say('back_note', renderTemplate_('survey_back_note', { answer: surveyAnswerText_(qid, a) || '—' }), null, { kind: 'survey_notice' });
    surveyAsk_(t, sv, qid, 'q');
    return true;
  }
  // FB_NOTE: новий фідбек (не звернення, не КРИТИЧНЕ)
  if (isBtn && (btnIs_(text, BTN.DONE) || btnIs_(text, BTN.CANCEL) || btnIs_(text, BTN.BACK))) {
    if ((ctx.n || 0) > 0) fbFinish_(t, renderTemplate_('fb_add_done'), 'fb_done');
    else fbFinish_(t, renderTemplate_('fb_add_empty'), 'fb_empty');
    return true;
  }
  const info = incomingInfo_(t);
  if (!info.text && !info.atts.length) { t.say('fb_add', renderTemplate_('fb_add_prompt'), kbReply_([[BTN.DONE], [BTN.CANCEL]])); return true; }
  const labelled = Object.assign({}, info, { text: ('[Новий фідбек] ' + info.text).trim() });
  const dup = info.groupId ? messages_().find(function (x) {
    return x.participant_id === t.p.participant_id && x.media_group_id === toText_(info.groupId) && x.message_record_id !== info.msgId;
  }) : null;
  const msg = recordIncoming_(t, labelled, null);
  if (msg.survey_id !== sv.survey_id) messages_().update(msg, { survey_id: sv.survey_id });
  tooLargeNotice_(t, info);
  markFeedback_(t.p.participant_id, msg.created_at, 'feedback_note', msg.message_record_id);
  t.set({ dialog_context_json: jsonStr_({ q: 'FB_NOTE', n: (ctx.n || 0) + 1 }) });
  if (!dup) t.say('fb_added', renderTemplate_('fb_added'), kbReply_([[BTN.DONE], [BTN.CANCEL]]));
  return true;
}

function surveyBack_(t, sv, qid) {
  const r = surveyRecompute_(sv);
  const idx = r.plan.indexOf(qid);
  if (idx <= 0) { t.say('back_none', renderTemplate_('survey_back_none'), null, { kind: 'survey_notice' }); return true; }
  const prev = r.plan[idx - 1];
  const a = r.cur[prev];
  if (a) t.say('back_note', renderTemplate_('survey_back_note', { answer: surveyAnswerText_(prev, a) || '—' }), null, { kind: 'survey_notice' });
  surveyAsk_(t, sv, prev, 'q');
  return true;
}

function surveyMulti_(t, sv, qid, q, ctx, text, isButtonText, stale) {
  const sel = (ctx.sel || []).slice();
  const kb = function (s) { return surveyKb_(qid, { sel: s }); };
  const save = function (s) { t.set({ dialog_context_json: jsonStr_({ q: qid, sel: s, prompt_ms: ctx.prompt_ms || null }) }); };
  if (isButtonText && btnIs_(text, BTN.SURVEY_RESET)) {
    save([]);
    t.say('reset', surveyPromptText_(sv, qid, t.S), kb([]), { kind: 'survey_notice' });
    return true;
  }
  if (isButtonText && btnIs_(text, BTN.DONE)) {
    if (stale === 'before_prompt' || stale === 'prompt_not_delivered') { surveyStash_(t, sv); t.say('clarify', renderTemplate_('survey_clarify'), null); return true; }
    if (!sel.length) { t.say('empty', renderTemplate_('survey_multi_empty'), kb(sel), { kind: 'survey_notice' }); return true; }
    surveySaveAnswer_(t, sv, qid, { format: 'multi', json: { codes: sel }, text: surveySelLabels_(qid, sel) });
    surveyAdvance_(t, sv);
    return true;
  }
  let code = null;
  const bare = text.replace(/^✓\s*/, '');
  q.options.forEach(function (o) { if (isButtonText && btnIs_(bare, o[1])) code = o[0]; });
  if (!code && isButtonText) {
    const mm = bare.match(/^(\d{1,2})$/);
    if (mm && q.options[parseInt(mm[1], 10) - 1]) code = q.options[parseInt(mm[1], 10) - 1][0];
  }
  if (!code) {                                         // довільний текст на питання з кнопками: зберігаємо й підказуємо
    if (!toText_(t.pl.message.text) && !(t.pl.message.attachments || []).length) { t.say('empty', surveyPromptText_(sv, qid, t.S), kb(sel), { kind: 'survey_notice' }); return true; }
    surveyStash_(t, sv);
    t.say('hint', renderTemplate_('survey_choose_hint'), kb(sel), { kind: 'survey_notice' });
    return true;
  }
  if (stale === 'before_prompt') { surveyStash_(t, sv); t.say('clarify', renderTemplate_('survey_clarify'), null); return true; }
  const at = sel.indexOf(code);
  if (at >= 0) { sel.splice(at, 1); save(sel); t.say('toggle', sel.length ? renderTemplate_('survey_multi_state', { selected: surveySelLabels_(qid, sel) }) : surveyPromptText_(sv, qid, t.S), kb(sel), { kind: 'survey_notice' }); return true; }
  const excl = q.exclusive || [];
  const conflict = (excl.indexOf(code) >= 0 && sel.length > 0) || sel.some(function (c) { return excl.indexOf(c) >= 0; });
  if (conflict) {
    t.say('conflict', renderTemplate_('survey_multi_conflict', { selected: surveySelLabels_(qid, sel) }), kb(sel), { kind: 'survey_notice' });
    return true;
  }
  sel.push(code);
  save(sel);
  t.say('toggle', renderTemplate_('survey_multi_state', { selected: surveySelLabels_(qid, sel) }), kb(sel), { kind: 'survey_notice' });
  return true;
}

/** Редагування повідомлення-відповіді: зберігаємо редакцію окремим рядком; завершену анкету мовчки не переписуємо. */
function onEditedMessageSurvey_(args) {
  const ev = args.ev, m = args.pl.message, p = args.p;
  const ans = answers_().find(function (a) { return a.participant_id === p.participant_id && a.telegram_message_id === toText_(m.message_id); });
  if (!ans) return false;
  const rid = msgIdFor_(ev.event_id);
  if (messages_().get(rid)) return true;
  const ms = Math.min(((m.edit_date || m.date) ? (m.edit_date || m.date) * 1000 : (parseIso_(ev.received_at) || nowMs_())), nowMs_());
  const body = toText_((m.text !== null && m.text !== undefined) ? m.text : m.caption);
  messages_().append({
    message_record_id: rid, participant_id: p.participant_id, ticket_id: null, survey_id: ans.survey_id, direction: 'in', author_type: 'participant',
    source_update_id: toText_(ev.update_id), telegram_message_id: toText_(m.message_id), reply_to_message_id: null, created_at: isoSec_(ms),
    body_text: '[Редагування відповіді ' + ans.question_id + '] ' + body, attachment_ids: null, media_group_id: null, related_reply_id: null
  });
  return true;
}
