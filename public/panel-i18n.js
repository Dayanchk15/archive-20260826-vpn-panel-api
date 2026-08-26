(function () {
  const key = 'vpn-panel-lang';
  window.panelLang = localStorage.getItem(key) || 'ru';
  const dictionaries = {
    ru: {
      'lang.ru': 'Русский', 'lang.en': 'English', 'lang.tk': 'Türkmen', 'lang.tr': 'Türkçe',
      'header.menu': 'Меню', 'header.theme': 'Тема', 'header.logout': 'Выйти',
      subtitle: 'Управление реальными VPS, службами и подписками.',
      'tab.home': 'Главная', 'tab.servers': 'Серверы', 'tab.managedServers': 'Реальные серверы',
      'tab.ips': 'IP и маршрутизация', 'tab.extraLinks': 'Дополнительные ключи',
      'tab.users': 'Пользователи', 'tab.clients': 'Клиенты', 'tab.logs': 'Логи', 'tab.settings': 'Настройки',
      'action.pick': 'Выберите действие', 'action.enable': 'Включить', 'action.disable': 'Отключить',
      'action.delete': 'Удалить', 'action.extend': 'Продлить', 'action.links': 'Ссылки клиента',
      'action.editClient': 'Изменить клиента', 'action.sync': 'Синхронизировать',
      'action.subscription': 'Изменить подписку', 'action.editDealer': 'Изменить дилера',
      'btn.apply': 'Применить', 'btn.close': 'Закрыть', 'btn.copy': 'Копировать',
      'btn.refresh': 'Обновить', 'btn.save': 'Сохранить',
      'prompt.pickAction': 'Сначала выберите действие', 'status.enabled': 'Включен', 'status.disabled': 'Отключен',
      'servers.action': 'Действия', 'dealers.action': 'Действия', 'servers.empty': 'Серверы не найдены',
      'dealers.empty': 'Дилеры не найдены', 'users.list': 'Пользователи',
      'servers.list': 'Список серверов', 'servers.bulkConfirm.syncUuids': 'Синхронизировать UUID на всех серверах?',
      'servers.bulkAction.syncUuids': 'Синхронизировать UUID', 'error.unauthorized': 'Сессия истекла. Войдите снова.',
      'confirm.enable': 'Включить сервер', 'confirm.disable': 'Отключить сервер', 'confirm.deleteServer': 'Удалить сервер',
      'confirm.deleteDealer': 'Удалить дилера', 'confirm.deleteDealerForce': 'Удалить дилера вместе с клиентами',
      'toast.alreadyOn': 'Сервер уже включен', 'toast.alreadyOff': 'Сервер уже отключен',
      'toast.enabled': 'Сервер включен', 'toast.disabled': 'Сервер отключен', 'toast.deleted': 'Удалено',
      'toast.extended': 'Срок продлен', 'toast.dealerCreated': 'Дилер создан', 'toast.saved': 'Сохранено',
      'prompt.extendDays': 'На сколько дней продлить?',
      'th.name': 'Название', 'th.ipMode': 'Режим IP', 'th.ips': 'IP-адреса', 'th.traffic': 'Трафик',
      'th.expires': 'Окончание', 'th.status': 'Статус', 'th.servers': 'Серверы',
      'ips.global': 'Общие IP для всех клиентов', 'ips.globalHint': 'Эти IP применяются к серверам без индивидуальной настройки.',
      'ips.globalMode': 'Общий режим', 'ips.customMode': 'Индивидуальный режим', 'ips.client': 'IP отдельного клиента',
      'ips.clientHint': 'Переопределяет общие IP только для выбранного клиента.', 'ips.byServers': 'IP по серверам',
      'ips.byClients': 'IP по клиентам', 'ips.applyAll': 'Применить для всех', 'ips.applyClient': 'Применить для клиента',
      'ips.resetClient': 'Сбросить настройки клиента',
      'logs.title': 'Журнал событий', 'logs.hint': 'Действия администратора, клиенты, службы VPS и ошибки панели.',
      'settings.apiUrl': 'API URL', 'settings.brandName': 'Название в клиенте', 'settings.hint': 'Основные настройки панели и обновлений.',
      'settings.save': 'Сохранить настройки', 'settings.syncAll': 'Синхронизировать все UUID', 'settings.updateInterval': 'Интервал обновления',
      'dealers.requiredFields': 'Заполните обязательные поля дилера', 'dealers.clientLimit': 'Лимит клиентов',
      'users.createHint': 'После создания появится ссылка подписки для клиента.', 'users.editTitle': 'Изменить клиента',
      'users.editLinkHint': 'Ссылка подписки останется прежней — клиенту нужно только обновить её в приложении.',
      'users.editNote': 'Примечание', 'users.editServers': 'Серверы клиента', 'users.editServersRequired': 'Выберите хотя бы один сервер',
      'users.editTrafficGb': 'Лимит трафика, ГБ', 'users.editSaved': 'Данные клиента сохранены',
      'users.selectAllServers': 'Выбрать все серверы', 'users.selectNoServers': 'Снять выбор', 'users.newUsersOnlyTag': 'Только новые клиенты',
      'settings.title': 'Настройки панели', 'settings.language': 'Язык интерфейса',
    },
    en: { 'lang.ru': 'Russian', 'lang.en': 'English', 'lang.tk': 'Turkmen', 'lang.tr': 'Turkish', subtitle: 'Manage real VPS, services and subscriptions.' },
    tk: { 'lang.ru': 'Rusça', 'lang.en': 'Iňlisçe', 'lang.tk': 'Türkmençe', 'lang.tr': 'Türkçe', subtitle: 'Hakyky VPS, hyzmatlar we abunalar.' },
    tr: { 'lang.ru': 'Rusça', 'lang.en': 'İngilizce', 'lang.tk': 'Türkmence', 'lang.tr': 'Türkçe', subtitle: 'Gerçek VPS, hizmetler ve abonelikleri yönetin.' },
  };
  window.PANEL_I18N = dictionaries;
  window.t = function t(name) {
    return dictionaries[window.panelLang]?.[name] || dictionaries.ru[name] || name;
  };
  window.applyPanelI18n = function applyPanelI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = window.t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = window.t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = window.t(el.dataset.i18nTitle); });
    document.querySelectorAll('.tab[data-i18n-tab]').forEach((el) => { el.textContent = window.t(el.dataset.i18nTab); });
    const select = document.getElementById('uiLanguageSettings');
    if (select) select.value = window.panelLang;
  };
  window.setPanelLanguage = function setPanelLanguage(lang) {
    if (!dictionaries[lang]) return;
    window.panelLang = lang;
    localStorage.setItem(key, lang);
    window.applyPanelI18n();
    if (typeof window.onPanelLanguageChange === 'function') window.onPanelLanguageChange();
  };
  window.addEventListener('DOMContentLoaded', window.applyPanelI18n);
})();
