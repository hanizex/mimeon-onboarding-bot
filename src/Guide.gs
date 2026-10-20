/**
 * Guide.gs — гайд по можливостях Mimeon усередині бота.
 *
 * Сторінки живуть в аркуші "Гайд" (page_id, order, title, text, image_url, enabled): команда редагує їх без коду.
 * Картинка (скриншот) — пряме https-посилання або file_id Telegram; надсилається окремим повідомленням перед текстом.
 * Якщо картинку Telegram відхилив (поганий URL), текст усе одно доходить: це окремі завдання в черзі, а помилка потрапляє в "Техжурнал".
 * Діалог 'guide' лише тримає клавіатуру розділів; кнопки меню й команди працюють як завжди.
 */

const GUIDE_MAX_PAGES = 12;
const GUIDE_TITLE_MAX = 14;
const GUIDE_TEXT_MAX = 3500;

/** Видимі сторінки в порядку order (потім page_id). Порожні назва або текст — пропускаються. */
function guidePages_() {
  const tbl = table_('GUIDE');
  tbl.load(3);
  const list = tbl.rows.filter(function (r) {
    return r.enabled !== false && String(r.title || '').trim() && String(r.text || '').trim();
  });
  list.sort(function (a, b) {
    const oa = typeof a.order === 'number' ? a.order : 1e9, ob = typeof b.order === 'number' ? b.order : 1e9;
    return oa !== ob ? oa - ob : String(a.page_id).localeCompare(String(b.page_id));
  });
  return list.slice(0, GUIDE_MAX_PAGES);
}

function guideLabel_(page, idx) { return (idx + 1) + '. ' + trunc_(String(page.title).trim(), GUIDE_TITLE_MAX); }

function guideKb_(pages) {
  return kbReply_([[BTN.BACK]].concat(packRows_(pages.map(guideLabel_))), { pack: false });
}

/** https-посилання або file_id Telegram; усе інше (порожньо, http:, пробіли) — без картинки. */
function guideImageRef_(v) {
  const s = String(v || '').trim();
  if (/^https:\/\/[^\s]{4,900}$/.test(s)) return s;
  if (/^[A-Za-z0-9_-]{30,200}$/.test(s)) return s;
  return null;
}

function guideOpen_(t) {
  const pages = guidePages_();
  if (!pages.length) { t.say('guide_empty', renderTemplate_('guide_empty'), mainMenuKb_()); return; }
  t.set({ dialog_type: 'guide', dialog_ref_id: null, dialog_context_json: null });
  t.say('guide_intro', renderTemplate_('guide_intro'), guideKb_(pages));
}

/** Яку сторінку обрано: точний підпис кнопки, «3», «3. …» або назва. */
function guideResolve_(pages, text) {
  const n = normText_(text);
  for (let i = 0; i < pages.length; i++) if (n === normText_(guideLabel_(pages[i], i))) return i;
  const m = /^(\d{1,2})(?:\s*[.)]|$)/.exec(n);
  if (m) { const k = parseInt(m[1], 10) - 1; if (k >= 0 && k < pages.length) return k; }
  for (let j = 0; j < pages.length; j++) if (n && n === normText_(pages[j].title)) return j;
  return -1;
}

/**
 * Хід у діалозі гайда. true — оброблено; false — це не вибір розділу (вільний текст): діалог закрито,
 * далі повідомлення піде звичайним шляхом, щоб нічого не загубилося.
 */
function guideDialog_(t, text) {
  const clear = { dialog_type: 'none', dialog_ref_id: null, dialog_context_json: null };
  if (btnIs_(text, BTN.BACK)) { t.set(clear); t.say('menu', renderTemplate_('menu_back')); return true; }
  const pages = guidePages_();
  if (!pages.length) { t.set(clear); t.say('guide_empty', renderTemplate_('guide_empty'), mainMenuKb_()); return true; }
  const kb = guideKb_(pages);
  if (btnIs_(text, BTN.MENU_GUIDE)) { t.say('guide_intro', renderTemplate_('guide_intro'), kb); return true; }
  const idx = guideResolve_(pages, text);
  if (idx < 0) { t.set(clear); return false; }
  const pg = pages[idx];
  const img = guideImageRef_(pg.image_url);
  if (img) t.photo('guide_img', img);
  t.say('guide_page', trunc_(String(pg.title).trim() + '\n\n' + String(pg.text).trim(), GUIDE_TEXT_MAX), kb);
  return true;
}
