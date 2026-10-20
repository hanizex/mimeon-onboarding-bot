/**
 * Tests.gs — швидкі перевірки чистої логіки прямо в Apps Script (без Telegram і без запису в таблицю).
 * Запуск: функція run_tests (меню запуску у редакторі). Результат — у журналі виконання.
 *
 * ЧЕСНО: це не повна перевірка. Повний набір (108 сценаріїв: анкета, винагороди, підтримка, відновлення після збоїв)
 * виконується у Node із імітацією Telegram і Таблиць — див. README, розділ «Тести».
 * Тут лише те, що можна перевірити без побічних ефектів.
 */
function runTests_() {
  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ name: name, ok: true }); } catch (e) { results.push({ name: name, ok: false, err: String(e && e.message || e) }); }
  }
  function eq(a, b) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('очікувалось ' + JSON.stringify(b) + ', отримано ' + JSON.stringify(a)); }
  const tz = 'Europe/Kyiv';
  const ymd = function (ms) { return Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd'); };

  t('календарний місяць: 31.01 → 28.02, 15.12 → 15.01', function () {
    eq(ymd(addLocalMonths_(parseFlexDate_('2027-01-31', tz), 1, tz)), '2027-02-28');
    eq(ymd(addLocalMonths_(parseFlexDate_('2027-12-15', tz), 1, tz)), '2028-01-15');
    eq(ymd(addLocalMonths_(parseFlexDate_('2028-01-31', tz), 1, tz)), '2028-02-29');
  });
  t('дата від команди: ISO, РРРР-ММ-ДД, ДД.ММ.РРРР; сміття = null', function () {
    eq(ymd(parseFlexDate_('2027-02-10', tz)), '2027-02-10');
    eq(ymd(parseFlexDate_('10.02.2027', tz)), '2027-02-10');
    eq(parseFlexDate_('вчора', tz), null);
    eq(parseFlexDate_('', tz), null);
  });
  t('email: перевірка форми', function () {
    eq(isValidEmail_('olena@example.com'), true);
    eq(isValidEmail_('olena@example'), false);
    eq(isValidEmail_('o lena@example.com'), false);
  });
  t('довгий текст ділиться на частини ≤ ліміту, нічого не втрачається', function () {
    const src = new Array(900).join('слово ');
    const parts = chunkText_(src, 4096);
    parts.forEach(function (p) { if (p.length > 4096) throw new Error('частина задовга'); });
    eq(parts.join(' ').replace(/\s+/g, ' ').trim(), src.replace(/\s+/g, ' ').trim());
  });
  t('SHA-256: відомий вектор', function () {
    eq(sha256Hex_('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  t('посилання: параметри кодуються, порожні пропускаються', function () {
    eq(addQuery_('https://x.y/p', { a: 'б в', b: '', c: null }), 'https://x.y/p?a=%D0%B1%20%D0%B2');
  });
  t('анкета: гілки за G1/G2/U5/U6', function () {
    const c = function (code) { return { codes: null, code: code }; };
    eq(surveyPlan_({}).plan, ['G1']);
    eq(surveyPlan_({ G1: { code: 'not_installed' } }).branch, 'not_started_experience');
    eq(surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_0' } }).branch, 'not_started_experience');
    const one = surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_1' } });
    eq(one.branch, 'one_day');
    eq(one.plan.indexOf('R1'), -1);
    const many = surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_2_3' } });
    eq(many.branch, 'multiple_days');
    eq(many.plan.indexOf('R1') > 0, true);
    const pub = surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_1' }, U5: { codes: ['publish'] } });
    eq(pub.plan.indexOf('P1') > 0, true);
    const nop = surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_1' }, U5: { codes: ['react'] } });
    eq(nop.plan.indexOf('P1'), -1);
    eq(nop.plan.indexOf('E1'), -1);
    const withE = surveyPlan_({ G1: { code: 'installed_during_test' }, G2: { code: 'days_1' }, U6: { code: 'yes' } });
    eq(withE.plan.indexOf('E1') > 0, true);
    c('x');
  });
  t('порівняння клітинок: null, порожній рядок, число', function () {
    eq(sameValue_(null, null), true);
    eq(sameValue_(null, 0), false);
  });

  const failed = results.filter(function (r) { return !r.ok; });
  results.forEach(function (r) { Logger.log((r.ok ? 'OK   ' : 'FAIL ') + r.name + (r.ok ? '' : ' — ' + r.err)); });
  Logger.log('Підсумок: ' + (results.length - failed.length) + '/' + results.length);
  return { total: results.length, failed: failed.map(function (f) { return f.name + ': ' + f.err; }) };
}
