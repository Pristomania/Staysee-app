# Реальный ResultURL Робокассы — локальный отключённый обработчик

Продолжение ранее одобренного плана оплаты. Только локальный код; не создавать/менять секреты, настройки магазина, production, checkout или кнопки оплаты. К памяти/моделям Claude не обращаться.

## Задача и подход

Уже есть закрытый live ledger095 и атомарный confirm_billing_live_order, но нет проверяющего подпись HTTP-адаптера. Добавить отдельную функцию robokassa-live-result. Не расширять test-handler переключателем: тестовый путь не должен получить вызов live confirm. SuccessURL остаётся лишь навигацией и никогда не выдаёт доступ.

Источники сверены20.11: https://docs.robokassa.ru/ru/notifications-and-redirects , /ru/pay-interface , /ru/testing-mode . Agent-reach Jina Reader не разрешил DNS, использован доступный web поиск официального сайта. Только основные ResultURL form POST, не JWS ResultUrl2/холды/рекурренты.

## Протокол

SHA256, исходная строка суммы (в production6 знаков после точки), InvId, live пароль#2, сортированные точные Shp_mode=live/Shp_shop=merchant. Перед lookup проверить envelope: одна копия каждого обязательного поля, все дубли/неизвестные Shp и case-алиасы отклоняются; строгий UTF8/form percent encoding; OutSum переводится в копейки без float-ошибки; дробные доли копейки не допускаются. IsTest отсутствует либо0, значение1 и другие отклоняются. MerchantLogin, если передан, должен совпасть с config. Email/метод оплаты/комиссия не сохраняются и не логируются.

Затем только таблица billing_live_orders: mode=live, merchant, invoice, amount соответствуют envelope. Подпись сравнивается без раннего выхода по символам. В тестах независимый SHA256-vector из node:crypto, не production builder на обеих сторонах.

## HTTP и выдача

Только POST application/x-www-form-urlencoded, без query, максимум8192 байт и24 поля. Заголовки no-store/text/plain, без browser CORS, JWT для provider callback не нужен, подпись обязательна. Вся обработка ограничена10секундами; внутренний test seam допускает меньший deadline. AbortSignal передаётся store/reader. DB lookup/confirm ошибки дают503 без деталей; неверный envelope/order400, слишком большое тело413, метод405/media415. Подделка не вызывает lookup/confirm.

Подтверждение вызывает существующий SQL confirm по закрытому UUID и точной сумме. Ответить OK{InvId} можно только после applied или paid_unfulfilled, в том числе на duplicate. Дубликат не обновляет срок/квоту/пакет. paid_unfulfilled означает учтённые деньги без доступа: ACK прекращает бессмысленный повтор, а отдельное нефатальное структурированное событие требует ручного разбора/возврата. Никаких автоматических возвратов/писем/Telegram. Сбой события не отменяет ACK уже учтённых денег.

Срок подтверждения095 сейчас захватывает now() до ожидания блокировок. В отдельной099 заменить только этот timestamp на clock_timestamp после usage/order locks, не менять алгоритм выдачи, каталог и grant_message_pack. Тест с открытой транзакцией до expiry должен после истечения принять покупку нового месячного периода, а не ошибочно paid_unfulfilled active_plan.

## Деплой-адаптер

Default disabled. ROBOKASSA_LIVE_RESULT_ENABLED=1 отдельно включает только подтверждения существующих live заказов. Не зависит от create_enabled: закрытие новых checkout не должно выбрасывать подтверждение старой оплаты. merchant/пароль#2 — отдельные live env, server-only. Совпадение live password2 с любым настроенным test password1/2 отключает обработчик; отсутствие test env само по себе не доказывает независимость секретов, отдельная ручная проверка перед live обязательна. Пароль#1 callback не использует. Холодный disabled/missing-config не создаёт DB client. Нет альтернативы test-ключам.

Supabase runtime service-role читает только нужные поля live ledger и вызывает только confirm RPC, abortSignal подключён. Не читать/печать `.env` или настоящие значения ключей инструментами. Новый endpoint не выкладывать, config/workflows не включать. Перед реальным подключением отдельная проверка merchant SHA256/POST/HTTPS/JWT gateway --no-verify-jwt, диапазона InvId при переносе и целого test/live пути.

## Проверки

Pure и HTTP: live/test separation, правильная/чужая подпись, сумма6digits, неверные копейки, case/duplicate/encoding/UTF8/oversize/chunked/методы, signed unknown invoice, mismatch mode/shop/amount/order, timeout/error/abort после возможного commit, повтор и paid_unfulfilled/event failure. Не ACK пока DB не подтвердила статус.

Интеграция на PGlite: настоящий signed Request→handler→реальные SQL095–099→тариф/пакет/история. Повтор не выдаёт дважды, тестовый envelope не меняет права, inactive оплаченный заказ остаётся учтённым без воскрешения. Публичные/пользовательские роли не могут вызвать confirm напрямую; source099 сохраняет ACL и funded budget. Полные offline/types/build, Deno только собственный автономный платёжный граф; старый граф памяти55 остаётся задачей пользователя.

Не считаем готовыми: реальную Робокассу/платёж/фискальные чеки/возвраты, live checkout/UI, боевой gateway, многосессионный PostgreSQL, привязку внешнего магазина к тому же backend. Всё это отдельные gates, деньги не тратить.
