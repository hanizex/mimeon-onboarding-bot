/**
 * Launcher.gs — НЕОБОВ'ЯЗКОВІ публічні обгортки для редактора Apps Script.
 *
 * Навіщо: функції з "_" у назві (приватні) можуть не з'являтися у списку "Запустити" редактора.
 * Якщо це так у вашому редакторі, задайте у Script Properties ALLOW_ADMIN_LAUNCHERS=true,
 * запустіть потрібну run_*, а після налаштування ВИДАЛІТЬ цю властивість (або весь файл Launcher.gs).
 *
 * Безпека: без ALLOW_ADMIN_LAUNCHERS=true обгортки нічого не виконують. HTML-переглядач
 * НЕ використовує google.script.run, тому ці функції недоступні з браузера.
 */

function launcherAllowed_() {
  return PropertiesService.getScriptProperties().getProperty('ALLOW_ADMIN_LAUNCHERS') === 'true';
}
function launcherGuard_(name) {
  if (!launcherAllowed_()) throw new Error('Launcher вимкнено. Задайте ALLOW_ADMIN_LAUNCHERS=true у Script Properties, щоб запустити ' + name + '.');
}
function run_bootstrap() { launcherGuard_('bootstrap_'); return bootstrap_(); }
function run_setup() { launcherGuard_('setup_'); return setup_(); }
function run_setupRebindOwner() { launcherGuard_('setupRebindOwner_'); return setupRebindOwner_(); }
function run_migrate() { launcherGuard_('migrate_'); return migrate_(); }
function run_applyBotProfile() { launcherGuard_('applyBotProfile_'); return applyBotProfile_(); }
function run_healthCheck() { launcherGuard_('healthCheck_'); return healthCheck_(); }
function run_measureTickCost() { launcherGuard_('measureTickCost_'); return measureTickCost_(); }
function run_tests() { launcherGuard_('runTests_'); return runTests_(); }
