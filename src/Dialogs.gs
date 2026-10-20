/**
 * Dialogs.gs — маршрутизація вхідних подій і незавершені контексти розмови.
 *
 * Кожна подія обробляється як "хід" (turn):
 *   1) вихідні повідомлення ставляться в Outbox з ключами від event_id (повтор не створює дублів);
 *   2) виконуються ідемпотентні побічні дії;
 *   3) стан учасника + last_event_id записуються одним оновленням рядка.
 * Якщо збій стався між кроками 1 і 3, повтор події дасть ті самі ключі й завершить крок 3;
 * якщо last_event_id уже дорівнює event_id — подія вважається застосованою.
 *
 * Модулі наступних етапів підключаються функціями-обробниками (див. delegate_):
 *   onMenuSupport_, onMenuCritical_, onMenuFeedback_, onMenuReward_, onFreeMessage_, onDialogMessage_, onEditedMessage_.
 */

function btnIs_(text, btn) { return normText_(text) === normText_(btn); }
function delegate_(fnName, arg) {
  const fn = (typeof globalThis !== 'undefined') ? globalThis[fnName] : null;
  if (typeof fn !== 'function') return false;
  fn(arg);
  return true;
}

/** Повертає результат обробника або undefined, якщо обробника ще немає (модуль наступного етапу не підключено). */
function delegateResult_(fnName, arg) {
  const fn = (typeof globalThis !== 'undefined') ? globalThis[fnName] : null;
  if (typeof fn !== 'function') return undefined;
  return fn(arg);
}

function newTurn_(ev, pl, S, p) {
  const t = { ev: ev, pl: pl, S: S, p: p, patch: {}, out: [], after: [], deleted: false, now: nowMs_() };
  /** kb: undefined -> головне меню; null -> без клавіатури; інакше — готовий reply_markup. */
  t.say = function (tag, text, kb, opts) {
    opts = opts || {};
    t.out.push({ tag: tag, text: text, kb: kb === undefined ? mainMenuKb_() : kb, kind: opts.kind || 'dialog', priority: opts.priority || PRIORITY.DIALOG, meta: opts.meta });
  };
  /** Картинка за URL або file_id (без клавіатури; клавіатура йде з наступним текстом). */
  t.photo = function (tag, ref, opts) {
    opts = opts || {};
    t.out.push({ tag: tag, media: { type: 'photo', file_id: ref }, kind: opts.kind || 'dialog', priority: opts.priority || PRIORITY.DIALOG, meta: opts.meta });
  };
  t.set = function (obj) { Object.keys(obj).forEach(function (k) { t.patch[k] = obj[k]; }); };
  t.run = function (fn) { t.after.push(fn); };
  return t;
}

function finishTurn_(t) {
  const p = t.p;
  t.out.forEach(function (o) {
    enqueueOutbox_({
      idempotencyKey: p.participant_id + ':' + t.ev.event_id + ':' + o.tag, participantId: p.participant_id, recipientChatId: p.chat_id,
      kind: o.kind, payload: o.media ? { media: o.media } : { text: o.text, reply_markup: o.kb || undefined }, priority: o.priority, meta: o.meta
    });
  });
  t.after.forEach(function (fn) { fn(); });
  const patch = {};
  Object.keys(t.patch).forEach(function (k) { patch[k] = t.patch[k]; });
  patch.last_event_id = t.ev.event_id;
  patch.last_seen_at = nowIso_();
  participants_().update(p, patch, { atomic: true });
}

// ---------- Вхід ----------
/** Повертає {status:'processed'|'ignored', note, deleted}. */
function handleInboxEvent_(ev, pl) {
  const S = settings_();
  if (pl.kind === 'message') return handleMessage_(ev, pl, S);
  if (pl.kind === 'edited_message') return handleEdited_(ev, pl, S);
  if (pl.kind === 'my_chat_member') return handleChatMember_(ev, pl, S);
  return { status: 'ignored', note: 'unknown_update_type' };
}

function handleChatMember_(ev, pl) {
  if (!pl.chat || pl.chat.type !== 'private' || !pl.from) return { status: 'ignored', note: 'non_private' };
  const p = participantByUser_(pl.from.id);
  if (!p) return { status: 'ignored', note: 'unknown_participant' };
  const ns = pl.my_chat_member && pl.my_chat_member.new_status;
  if (ns === 'kicked' || ns === 'left') {
    if (p.contact_status !== 'blocked') handleBlocked_(p.participant_id);
  } else if (ns === 'member') {
    if (p.contact_status === 'blocked') markUnblocked_(p);    // накопичені старі нагадування не відновлюються (інша schedule_version)
  }
  return { status: 'processed' };
}

function handleEdited_(ev, pl, S) {
  if (!pl.chat || pl.chat.type !== 'private' || !pl.from) return { status: 'ignored', note: 'non_private' };
  const p = participantByUser_(pl.from.id);
  if (!p) return { status: 'ignored', note: 'unknown_participant' };
  // обробники по черзі: звернення -> анкета (етап 3); перший, що впізнав повідомлення, завершує
  const args = { ev: ev, pl: pl, p: p, S: S };
  const handlers = ['onEditedMessageSupport_', 'onEditedMessageSurvey_'];
  for (let i = 0; i < handlers.length; i++) {
    if (delegateResult_(handlers[i], args) === true) return { status: 'processed' };
  }
  return { status: 'ignored', note: 'edited_not_handled' };
}

function handleMessage_(ev, pl, S) {
  if (!pl.chat || pl.chat.type !== 'private') return { status: 'ignored', note: 'non_private' };
  const from = pl.from;
  if (!from || from.is_bot) return { status: 'ignored', note: 'no_user' };
  const chatId = idText_(pl.chat.id);
  const ownerId = propGet_(PROP.OWNER_TELEGRAM_USER_ID);
  if (ownerId && String(from.id) === String(ownerId) && !isTestChat_(chatId, S)) return handleOwnerMessage_(ev, pl, chatId);

  let p = participantByUser_(from.id);
  let created = false;
  if (!p) { p = createParticipant_(from, chatId, S); created = true; }
  if (!created && p.last_event_id === ev.event_id) return { status: 'processed', note: 'already_applied' };

  const t = newTurn_(ev, pl, S, p);
  const meta = metadataPatch_(p, from);
  t.set(meta);
  if (String(p.chat_id) !== chatId) t.set({ chat_id: chatId });
  if (p.contact_status === 'blocked') markUnblocked_(p);
  route_(t);
  if (t.deleted) return { status: 'processed', deleted: true, note: 'participant_deleted' };
  finishTurn_(t);
  return { status: 'processed' };
}

// ---------- Власник ----------
function handleOwnerMessage_(ev, pl, chatId) {
  const cmd = parseCommand_(pl.message.text);
  let text;
  let kind = 'owner_notice';
  if (cmd && cmd.name === 'status') { text = renderTemplate_('owner_status', { status: ownerStatusText_() }); kind = 'owner_status'; }
  else if (cmd && (cmd.name === 'stats' || cmd.name === 'funnel')) { text = ownerStatsText_(); kind = 'owner_status'; }
  else if (cmd && cmd.name === 'live') text = ownerLiveText_(cmd.arg);
  else if (cmd && cmd.name === 'botprofile') {
    const r = applyBotProfile_();
    text = r.ok ? 'Профіль бота оновлено: короткий опис, повний опис і меню команд.' : 'Профіль бота оновлено не повністю: ' + r.failed.join('; ');
  }
  else if (cmd && cmd.name === 'bind_owner') text = 'Власника вже прив\'язано. Повторна прив\'язка можлива лише після нової явної дії власника в редакторі Apps Script (setup_()).';
  else text = renderTemplate_('owner_not_participant') + '\n\n' + ownerDiagText_(chatId);
  enqueueOutbox_({ idempotencyKey: 'owner:' + ev.event_id, participantId: null, recipientChatId: chatId, kind: kind, payload: { text: text }, priority: PRIORITY.OWNER_ALERT });
  return { status: 'processed', note: 'owner_command' };
}

const LIVE_MAX_MINUTES = 240;
/** /live [хвилин|off]: бот слухає Telegram безперервно (відповідь за секунди навіть після паузи). Витрачає квоту тригерів. */
function ownerLiveText_(arg) {
  const S = settings_();
  const a = String(arg || '').trim().toLowerCase();
  if (a === 'off' || a === 'stop' || a === '0') { propDelete_(PROP.LIVE_UNTIL); return 'Режим «на зв\'язку» вимкнено. Далі швидка відповідь працює лише поки є активність.'; }
  let min = a ? parseInt(a, 10) : 60;
  if (!(min > 0)) return 'Напишіть /live 60 (хвилин, до ' + LIVE_MAX_MINUTES + ') або /live off.';
  min = Math.min(min, LIVE_MAX_MINUTES);
  const now = nowMs_();
  const q = quotaToday_(S, now);
  if (q.usedSec >= q.guardSec) return 'Не вмикаю: сьогодні вже використано ~' + Math.round(q.usedSec / 60) + ' хв із ' + Math.round(q.limitSec / 60) + ' хв квоти (запобіжник ' + S.QUOTA_GUARD_PERCENT + '%). Спробуйте завтра.';
  propSet_(PROP.LIVE_UNTIL, isoSec_(now + min * 60000));
  const left = Math.max(0, Math.round((q.guardSec - q.usedSec) / 60));
  return 'Режим «на зв\'язку» увімкнено на ' + min + ' хв (до ' + localDateTimeStr_(now + min * 60000, S.TIMEZONE) + '). Бот слухає Telegram безперервно: відповідь за кілька секунд.\n' +
    'Це витрачає квоту: до ~' + min + ' хв. До запобіжника сьогодні лишилось ~' + left + ' хв. Вимкнути: /live off.';
}

function quotaLine_(S) {
  const q = quotaToday_(S, nowMs_());
  const fu = safeJsonParse_(propGet_(PROP.FAST_USED), null);
  const fast = fu && fu.d === q.day ? Math.round((Number(fu.s) || 0) / 60) : 0;
  const lu = liveUntilMs_();
  return 'Квота запусків сьогодні (оцінка): ~' + Math.round(q.usedSec / 60) + ' хв із ' + Math.round(q.limitSec / 60) + ' (' + Math.round(q.usedSec / q.limitSec * 100) + '%), запобіжник на ' + S.QUOTA_GUARD_PERCENT +
    '%. Швидкий режим: ' + fast + ' хв.' + (lu ? ' Режим /live до ' + localDateTimeStr_(lu, S.TIMEZONE) + '.' : '');
}

/** Підказка власнику: його chat_id і чи він у TEST_CHAT_ALLOWLIST (щоб пройти онбординг як тестовий учасник). */
function ownerDiagText_(chatId) {
  const S = settings_();
  const list = S.TEST_CHAT_ALLOWLIST;
  const inList = list.indexOf(String(chatId)) >= 0;
  return 'Діагностика: ваш chat_id = ' + chatId + '. TEST_CHAT_ALLOWLIST зараз: ' + (list.length ? list.join(', ') : '(порожній)') +
    (inList ? ' — ви в списку.' : ' — вас у списку немає.') +
    '\nЩоб пройти онбординг цим акаунтом як учасник: у таблиці, аркуш "Налаштування", рядок TEST_CHAT_ALLOWLIST, колонка "Значення" — вставте ' + chatId +
    ' (лише цифри, без пробілів і лапок), зачекайте 1–2 хвилини і надішліть /start.';
}

function ownerStatusText_() {
  const S = settings_();
  const pt = participants_();
  const real = pt.filter(function (p) { return p.is_test_record !== true; });
  const by = {};
  real.forEach(function (p) { by[p.participation_status] = (by[p.participation_status] || 0) + 1; });
  const ob = {};
  outbox_().rows.forEach(function (j) { ob[j.status] = (ob[j.status] || 0) + 1; });
  const lastTick = propGet_(PROP.LAST_TICK_AT) || '—';
  const lines = [
    'Mimeon alpha — статус',
    'Учасників (без тестових): ' + real.length + (S.MAX_PARTICIPANTS > 0 ? ' / ' + S.MAX_PARTICIPANTS : ' (без ліміту)'),
    'За участю: ' + (Object.keys(by).map(function (k) { return k + '=' + by[k]; }).join(', ') || '—'),
    'Черга (у вікні перегляду): ' + (Object.keys(ob).map(function (k) { return k + '=' + ob[k]; }).join(', ') || 'порожня'),
    'Останній запуск: ' + lastTick,
    'Режими: TEST_MODE=' + S.TEST_MODE + ', DELIVERY_ENABLED=' + S.DELIVERY_ENABLED,
    quotaLine_(S),
    'Версія: ' + APP_VERSION
  ];
  const ownerChat = propGet_(PROP.OWNER_CHAT_ID);
  try { lines.push(supportStatusLines_()); } catch (e) { /* таблиці звернень може не бути на ранніх етапах */ }
  if (ownerChat) lines.push(ownerDiagText_(ownerChat));
  if (G().settingsProblems && G().settingsProblems.length) lines.push('Проблеми налаштувань: ' + G().settingsProblems.join('; '));
  return lines.join('\n');
}

// ---------- Маршрутизація ----------
function dataMenuKb_(t) {
  const p = t.p;
  const rows = [[BTN.DATA_VIEW], [BTN.DATA_END], [p.contact_status === 'opted_out' ? BTN.DATA_UNMUTE : BTN.DATA_MUTE], [BTN.DATA_DELETE]];
  if (canExtend_(p, t.S, t.now)) rows.push([BTN.EXTEND]);
  rows.push([BTN.BACK]);
  return kbReply_(rows);
}

/** Меню "Участь і дані" та його дії. Повертає true, якщо текст оброблено. */
function routeData_(t, text, cmd) {
  const p = t.p;
  if ((cmd && cmd.name === 'stop') || btnIs_(text, BTN.MENU_DATA)) {
    t.say('data_menu', renderTemplate_('data_menu'), dataMenuKb_(t));
    return true;
  }
  if ((cmd && cmd.name === 'mydata') || btnIs_(text, BTN.DATA_VIEW)) {
    if (!delegateTurn_('onMenuMyData_', t)) featureUnavailable_(t);
    return true;
  }
  if ((cmd && cmd.name === 'delete') || btnIs_(text, BTN.DATA_DELETE)) {
    t.set({ dialog_type: 'delete_confirmation', dialog_ref_id: null, dialog_context_json: null });
    t.say('delete_confirm', renderTemplate_('delete_confirm'), kbReply_([[BTN.DELETE_YES], [BTN.DELETE_NO]], { oneTime: true }));
    return true;
  }
  if (btnIs_(text, BTN.DATA_END)) {
    t.say('ended', renderTemplate_('ended'), p.consent_at ? mainMenuKb_() : null);
    t.run(function () { endParticipation_(p); });
    return true;
  }
  if (btnIs_(text, BTN.DATA_MUTE)) {
    t.say('muted', renderTemplate_('muted'), mainMenuKb_());
    t.run(function () { muteParticipant_(p); });
    return true;
  }
  if (btnIs_(text, BTN.DATA_UNMUTE)) {
    t.say('unmuted', renderTemplate_('unmuted'), mainMenuKb_());
    t.run(function () { unmuteParticipant_(p); });
    return true;
  }
  return false;
}

function route_(t) {
  const p = t.p, S = t.S;
  const text = normText_(t.pl.message.text);
  let cmd = parseCommand_(t.pl.message.text);
  const attachments = t.pl.message.attachments || [];
  // у діалозі звернення невідома "команда" (наприклад, текст "/home не відкривається") — це просто текст
  if (cmd && (SUPPORT_DIALOGS.indexOf(p.dialog_type) >= 0 || p.dialog_type === 'survey_question') && KNOWN_COMMANDS.indexOf(cmd.name) < 0) cmd = null;

  // Підтвердження видалення має найвищий пріоритет серед текстових відповідей
  if (p.dialog_type === 'delete_confirmation' && !cmd) {
    if (btnIs_(text, BTN.DELETE_YES)) { doDelete_(t); return; }
    if (btnIs_(text, BTN.DELETE_NO)) {
      t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null });
      t.say('delete_cancelled', renderTemplate_('delete_cancelled'), p.consent_at ? mainMenuKb_() : null);
      return;
    }
    t.say('delete_confirm', renderTemplate_('delete_confirm'), kbReply_([[BTN.DELETE_YES], [BTN.DELETE_NO]], { oneTime: true }));
    return;
  }

  // Місце в черзі
  if (p.participation_status === 'waiting_capacity') {
    if (routeData_(t, text, cmd)) return;
    t.say('waiting', renderTemplate_('waiting_capacity'), kbReply_([[BTN.MENU_DATA]]));
    return;
  }

  // Згода
  if (!p.consent_at) { routeConsent_(t, text, cmd); return; }

  // Анкета: службові кнопки/команди (пауза, повернення, перехід у меню) мають пріоритет над трактуванням тексту як відповіді
  let dlg = p.dialog_type;
  if (dlg === 'survey_question') {
    const r = surveyBeforeRoute_(t, text, cmd);
    if (r === true) return;
    if (r === false) dlg = 'none';                       // діалог анкети завершено (стан збережено); далі — звичайна маршрутизація
  }

  // Команди мають пріоритет над трактуванням тексту як відповіді діалогу
  if (cmd) { routeCommand_(t, cmd, text); return; }

  // Незавершені діалоги
  switch (dlg) {
    case 'onboarding_platform': routePlatform_(t, text); return;
    case 'onboarding_role': routeRole_(t, text); return;
    case 'support_body': case 'support_details': case 'support_choose':
      // кнопки меню завжди працюють: діалог звернення завершується, дія виконується як звичайно
      if (isMenuInput_(text)) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); break; }
      if (!delegateTurn_('onDialogMessageSupport_', t)) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); featureUnavailable_(t); }
      return;
    case 'survey_question':
      if (!delegateTurn_('onDialogMessageSurvey_', t)) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); featureUnavailable_(t); }
      return;
    case 'guide':
      // розділ гайда, «Назад», «Гайд»: гайд відповідає сам; кнопки меню й вільний текст закривають діалог і йдуть звичайним шляхом
      if ((!isMenuInput_(text) || btnIs_(text, BTN.BACK) || btnIs_(text, BTN.MENU_GUIDE)) && guideDialog_(t, text)) return;
      t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null });
      break;
    case 'reward_choice': case 'reward_email': case 'reward_public_name':
      if (isMenuInput_(text)) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); break; }       // кнопки меню завжди працюють
      if (!delegateTurn_('onDialogMessageReward_', t)) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); featureUnavailable_(t); }
      return;
    default: break;
  }

  if (routeData_(t, text, null)) return;
  routeMenu_(t, text, attachments);
}

/** true — обробник існує й обробив хід; false — обробника немає або він повернув false. */
function delegateTurn_(fnName, t) {
  const r = delegateResult_(fnName, t);
  return r !== undefined && r !== false;
}
const MENU_INPUTS = ['MENU_MEMO', 'MENU_GUIDE', 'MENU_SUPPORT', 'MENU_CRITICAL', 'MENU_FEEDBACK', 'MENU_REWARD', 'MENU_DATA',
  'DATA_VIEW', 'DATA_END', 'DATA_MUTE', 'DATA_UNMUTE', 'DATA_DELETE', 'BACK', 'EXTEND', 'STOP_REMINDERS', 'GIVE_FEEDBACK'];
function isMenuInput_(text) { return MENU_INPUTS.some(function (k) { return btnIs_(text, BTN[k]); }); }

function routeConsent_(t, text, cmd) {
  const p = t.p, S = t.S;
  if (routeData_(t, text, cmd)) return;
  if (cmd && cmd.name === 'help') { t.say('help', renderTemplate_('help'), null); return; }
  if (btnIs_(text, BTN.CONSENT)) {
    if (!tryReserveSlot_(t)) { t.say('waiting', renderTemplate_('waiting_capacity'), kbReply_([[BTN.MENU_DATA]])); return; }
    t.set({ consent_version: S.CONSENT_VERSION, consent_at: nowIso_(), age_16_confirmed: true, participation_status: 'onboarding', dialog_type: 'onboarding_platform', declined_at: null });
    t.say('platform_q', renderTemplate_('platform_q'), kbReply_([[BTN.PLATFORM_ANDROID], [BTN.PLATFORM_IOS], [BTN.PLATFORM_BOTH]]));
    return;
  }
  if (btnIs_(text, BTN.DECLINE)) {
    t.set({ participation_status: 'withdrawn', declined_at: nowIso_(), enrollment_slot_reserved: false });
    t.say('declined', renderTemplate_('consent_declined'), kbRemove_());
    return;
  }
  const consentKb = kbReply_([[BTN.CONSENT], [BTN.DECLINE]], { oneTime: true });
  if (cmd && cmd.name === 'start' || p.last_event_id === null) {
    if (p.participation_status === 'withdrawn' && !tryReserveSlot_(t)) { t.say('waiting', renderTemplate_('waiting_capacity'), kbReply_([[BTN.MENU_DATA]])); return; }
    t.say('greeting', renderTemplate_('greeting'), consentKb);
    return;
  }
  t.say('consent_repeat', renderTemplate_('consent_repeat'), consentKb);
}

function tryReserveSlot_(t) {
  const p = t.p, S = t.S;
  if (p.enrollment_slot_reserved === true) return true;
  if (p.is_test_record === true || !slotsFull_(S)) {
    t.set({ enrollment_slot_reserved: true, participation_status: 'onboarding' });
    return true;
  }
  t.set({ participation_status: 'waiting_capacity' });
  return false;
}

function routePlatform_(t, text) {
  let v = null;
  if (btnIs_(text, BTN.PLATFORM_ANDROID)) v = 'android';
  else if (btnIs_(text, BTN.PLATFORM_IOS)) v = 'ios';
  else if (btnIs_(text, BTN.PLATFORM_BOTH)) v = 'both';
  if (!v) {
    t.say('platform_hint', renderTemplate_('platform_role_hint') + '\n\n' + renderTemplate_('platform_q'), kbReply_([[BTN.PLATFORM_ANDROID], [BTN.PLATFORM_IOS], [BTN.PLATFORM_BOTH]]));
    return;
  }
  t.set({ platform: v, dialog_type: 'onboarding_role' });
  t.say('role_q', renderTemplate_('role_q'), kbReply_([[BTN.ROLE_AUTHOR], [BTN.ROLE_VIEWER], [BTN.ROLE_BOTH]]));
}

function routeRole_(t, text) {
  const p = t.p, S = t.S;
  let v = null;
  if (btnIs_(text, BTN.ROLE_AUTHOR)) v = 'author';
  else if (btnIs_(text, BTN.ROLE_VIEWER)) v = 'viewer';
  else if (btnIs_(text, BTN.ROLE_BOTH)) v = 'both';
  if (!v) {
    t.say('role_hint', renderTemplate_('platform_role_hint') + '\n\n' + renderTemplate_('role_q'), kbReply_([[BTN.ROLE_AUTHOR], [BTN.ROLE_VIEWER], [BTN.ROLE_BOTH]]));
    return;
  }
  const links = buildStoreLinks_(p.platform || 'both', S);
  t.set({
    declared_role: v, dialog_type: 'none', store_link_urls_json: JSON.stringify(links.urls),
    android_link_tagged: links.androidTagged, ios_link_tagged: links.iosTagged
  });
  // посилання — ключ participant_id + initial_store_links; старт тесту ставиться ПІСЛЯ підтвердженої доставки (onStoreLinksSent_)
  t.run(function () {
    enqueueOutbox_({
      idempotencyKey: p.participant_id + ':initial_store_links', participantId: p.participant_id, recipientChatId: p.chat_id,
      kind: 'initial_store_links', payload: { text: renderTemplate_('store_links'), reply_markup: kbInlineUrls_(links.buttons) }, priority: PRIORITY.DIALOG
    });
  });
}

function routeCommand_(t, cmd, text) {
  const p = t.p;
  switch (cmd.name) {
    case 'start': resumeState_(t); return;
    case 'help': t.say('help', renderTemplate_('help')); return;
    case 'guide': guideOpen_(t); return;
    case 'support': if (!delegateTurn_('onMenuSupport_', t)) featureUnavailable_(t); return;
    case 'critical': if (!delegateTurn_('onMenuCritical_', t)) featureUnavailable_(t); return;
    case 'feedback': if (!delegateTurn_('onMenuFeedback_', t)) featureUnavailable_(t); return;
    case 'reward': if (!delegateTurn_('onMenuReward_', t)) featureUnavailable_(t); return;
    case 'cancel':
      if (typeof onCancelSupport_ === 'function' && onCancelSupport_(t)) return;
      if (typeof REWARD_DIALOGS !== 'undefined' && REWARD_DIALOGS.indexOf(p.dialog_type) >= 0) { t.set({ dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null }); t.say('cancelled', renderTemplate_('support_cancelled')); return; }
      t.say('menu', renderTemplate_('menu_back'));
      return;
    case 'stop': case 'delete': case 'mydata': routeData_(t, text, cmd); return;
    default: t.say('unknown_cmd', renderTemplate_('unknown_text')); return;
  }
}

function featureUnavailable_(t) { t.say('unavail', renderTemplate_('feature_unavailable')); }

/** /start для вже відомого учасника: відновити стан, не змінюючи початку тесту. */
function resumeState_(t) {
  const p = t.p, S = t.S;
  if (p.dialog_type === 'onboarding_platform') { t.say('platform_q', renderTemplate_('platform_q'), kbReply_([[BTN.PLATFORM_ANDROID], [BTN.PLATFORM_IOS], [BTN.PLATFORM_BOTH]])); return; }
  if (p.dialog_type === 'onboarding_role') { t.say('role_q', renderTemplate_('role_q'), kbReply_([[BTN.ROLE_AUTHOR], [BTN.ROLE_VIEWER], [BTN.ROLE_BOTH]])); return; }
  if (p.dialog_type === 'delete_confirmation') { t.say('delete_confirm', renderTemplate_('delete_confirm'), kbReply_([[BTN.DELETE_YES], [BTN.DELETE_NO]], { oneTime: true })); return; }
  if (p.trial_started_at) { t.say('memo', memoText_(p, S), mainMenuKb_()); return; }
  t.say('menu', renderTemplate_('menu_back'));
}

function routeMenu_(t, text, attachments) {
  const p = t.p, S = t.S;
  if (btnIs_(text, BTN.MENU_MEMO)) {
    if (p.trial_started_at) t.say('memo', memoText_(p, S), mainMenuKb_());       // повторна пам'ятка не перезапускає таймер
    else t.say('memo_nr', renderTemplate_('memo_not_ready'));
    return;
  }
  if (btnIs_(text, BTN.MENU_GUIDE)) { guideOpen_(t); return; }
  if (btnIs_(text, BTN.BACK)) { t.say('menu', renderTemplate_('menu_back')); return; }
  if (btnIs_(text, BTN.EXTEND)) {
    if (canExtend_(p, S, t.now)) {
      const endMs = parseIso_(p.trial_max_end_at);
      t.say('ext', renderTemplate_('extension_done', { end_date: localDateDots_(endMs, S.TIMEZONE) }), mainMenuKb_());
      t.run(function () { applyExtension_(p, S, t.now, null); });
    } else t.say('ext', renderTemplate_('extension_unavailable'), mainMenuKb_());
    return;
  }
  if (btnIs_(text, BTN.STOP_REMINDERS)) {
    t.set({ reminders_enabled: false });
    t.say('rem_off', renderTemplate_('reminders_off'), mainMenuKb_());
    t.run(function () { cancelJobs_(function (j) { return j.participant_id === p.participant_id && j.message_kind === 'survey_reminder'; }, 'Нагадування вимкнено учасником'); });
    return;
  }
  if (btnIs_(text, BTN.MENU_SUPPORT)) { if (!delegateTurn_('onMenuSupport_', t)) featureUnavailable_(t); return; }
  if (btnIs_(text, BTN.MENU_CRITICAL)) { if (!delegateTurn_('onMenuCritical_', t)) featureUnavailable_(t); return; }
  if (btnIs_(text, BTN.MENU_FEEDBACK) || btnIs_(text, BTN.GIVE_FEEDBACK)) { if (!delegateTurn_('onMenuFeedback_', t)) featureUnavailable_(t); return; }
  if (btnIs_(text, BTN.MENU_REWARD)) { if (!delegateTurn_('onMenuReward_', t)) featureUnavailable_(t); return; }

  // Вільне повідомлення поза опитуванням і діалогом -> звичайне звернення (етап 2). Не ігноруємо.
  if (text || attachments.length) {
    if (!delegateTurn_('onFreeMessage_', t)) featureUnavailable_(t);
    return;
  }
  t.say('unknown', renderTemplate_('unknown_text'));
}

function doDelete_(t) {
  const p = t.p, S = t.S;
  const chatId = String(p.chat_id);
  const res = deleteParticipantData_(p);
  const external = (res.external && res.external.length) ? '; а також: ' + res.external.join('; ') : '';
  // підтвердження — напряму, chat_id лише в пам'яті; жодного запису про людину не створюється
  if (chatAllowed_(chatId, 'delete_receipt', S)) {
    const text = renderTemplate_('delete_done', { summary: deleteSummaryText_(res.counts), external: external });
    tgSendMessage_(chatId, { text: text, reply_markup: kbRemove_() });
  }
  t.deleted = true;
}
