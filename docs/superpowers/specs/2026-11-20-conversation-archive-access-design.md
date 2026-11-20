# Серверные замки бесед и безопасное удаление

Статус: локальная реализация по подтверждённому поручению «выполняй», без выкладки/боевых действий. Память и модели Claude не переписывать. Зависит от095–097, не считать ранее завершённую097 полной защитой.

## Продуктовый контракт

- На действующем basic/premium все ранее созданные собственные беседы доступны; превышение лимита числа запрещает только создание. Premium→basic не закрывает старые строки: предложение о трёх читаемых не утверждено.
- Срок тарифа, а не квота, определяет права. После expiry free читает только фиксированный ID верхней беседы. Пакет на free ничего дополнительно не открывает.
- Любую собственную беседу, в том числе закрытую, можно удалить отдельно с подтверждением. Удаление закрытой не меняет доступную. Удаление доступной не открывает архив; разрешается новая пустая. Переписка остальных не меняется. Удаление всех также доступно без оплаты.
- Пока тариф действует, беседы можно переместить наверх; дальнейшая активность в другой беседе делает её верхней. Переименование порядок не меняет. Время последнего сообщения не подделывать ради сортировки. Этот порядок — инженерное уточнение Codex прежнего поведения latest-message-first; подсказка объясняет выбор перед expiry.
- Список закрытых показывает только разрешённые метаданные, без preview/summary/metadata/поисковых фрагментов. Прямой запрос известного ID не раскрывает содержимое.
- При потере проверенных прав клиент прячет/сбрасывает загруженное содержимое и прекращает запросы. Уже полученные внешние копии не отзываются.

## Выбранный способ

RLS на содержимое плюс отдельный безопасный list RPC. Только frontend-замки обходятся API. Отдельный прокси всех SQL-запросов потребовал бы переписать все readers; единая БД-проверка сохраняет прямое чтение разрешённых строк, preview RPC и service endpoints ограничиваются отдельно.

## Сервер

Добавить usage.free_conversation_id без FK: удалённый ID остаётся tombstone и не превращается автоматически в следующий. Инициализировать верхней активной беседой при миграции. При действующем полном доступе триггеры обновляют anchor после создания/изменения порядка/удаления; переход на оплаченный тариф выбирает текущую верхнюю. После expiry права вычисляются по серверным часам без необходимости cron/quota; anchor больше не меняется. Для новых free anchor задаётся только созданием новой пустой.

Полный доступ к беседам: действующий paid tier или unlimited; сохранить явные ручные многокомнатные назначения (manual и max_conversations_override>1) как служебное исключение. Последнее не даёт платных функций при raw free. Обычный free без override — один anchor. Проверки платных features отдельны: basic/premium действующие по сроку (как paidAccess.ts). Снятый/удалённый/заблокированный профиль не получает чтение. Отсутствующий usage — fail closed, создание требует исправной billing-строки, которую обычно создаёт signup021; не создавать её автоматически и не угадывать тариф.

Порядок: nullable conversations.manual_sort_at; ORDER BY greatest(last_message_at,coalesce(manual_sort_at,last_message_at)) DESC, created_at DESC,id DESC. Только server RPC двигает manual_sort_at. Guard/trigger не позволяет правкой клиентских timestamp/free-порядка сменить anchor. Все операции создания/перестановки/удаления сначала блокируют usage; последующий clock_timestamp проверяет реальный срок.

Интерфейсы новой миграции098:

- `can_read_my_conversation(p_conversation_id uuid) RETURNS boolean`: auth.uid-bound, definer, без данных о чужих ID. Подключён restrictive SELECT policies conversations/messages/embeddings и связанных читателей.
- `has_my_paid_features() RETURNS boolean`: auth.uid-bound проверка срока и активности, не квоты.
- `get_my_conversation_access(p_conversation_id uuid DEFAULT NULL) RETURNS jsonb`: только `{allowed:boolean, paidFeatures:boolean, fullAccess:boolean}`. NULL ID означает проверку features, не разрешение доступа к произвольной беседе.
- `list_my_conversations() RETURNS jsonb`: массив только `{id,user_id,title,is_active,created_at,last_message_at,can_read}` в серверном порядке. Без summary и settings. Собственные активные, включая закрытые; нет молчаливого обрезания архива.
- `delete_my_conversation(p_conversation_id uuid) RETURNS boolean`: self-only definer, delete own row с cascade, возвращает только успех. Удалённый/чужой ID не раскрывает существование. `delete_all_my_conversations(p_expected_user_id uuid) RETURNS void` требует совпадения UID подтверждения с auth.uid(), чтобы смена аккаунта не удаляла чужие для данного подтверждения данные.
- `rename_my_conversation(p_conversation_id uuid,p_title text) RETURNS boolean`: self-only метаданные, длина title ограничена200, не меняет порядок; разрешена для закрытой.
- `move_my_conversation_to_top(p_conversation_id uuid) RETURNS boolean`: own active, только полный paid/manual служебный доступ; free-пакет не даёт перестановку. Проверка под usage lock.

Все definer functions SET search_path='', частные helpers без EXECUTE authenticated/anon/PUBLIC, публичные self RPC только authenticated, никаких новых service grant напрямую на anchor/order. Отозвать authenticated INSERT/UPDATE произвольных столбцов conversations; разрешить создание только user_id/title/is_active, обновление нужных клиенту title,last_message_at,cross_memory_enabled. Anchor/order менять через definer trigger/RPC, не через raw REST. Существующие права service роли не расширять.

Уточнение по итогам ревью (имеет приоритет над прежней строкой об UPDATE): raw UPDATE оставлен только cross_memory_enabled; title/last_message_at идут через owner-scoped RPC. Существующее явное legacy summary edit/clear сохраняет `save_my_conversation_summary(id,summary)` с проверкой paid+own access, не широкий column grant. Authority generation монотонен и не переиспользуется при ABA. reserve_at/expire_at получают одно post-lock время от закрытого wrapper; клиент не может передать свою дату. Старый account-content wipe также сначала берёт usage lock.

Существующие сообщения/summary RLS ограничить дополнительными restrictive policies, чтобы альтернативные permissive policies не открыли закрытые строки. Preview063 SECURITY DEFINER заменить body с can_read_my_conversation. user_memory чтение только paid; progress_entries с conversation_id только доступные и weekly только paid; embeddings только доступные. Сервисные memory tables и viewer RPC уже service-only, не переписывать их алгоритмы.

Chat перед тратами требует allowed для переданного conversationId. Перед service-контекстом повторная проверка права; отказ после reserve не должен терять слот (не угадывать механизмы release — проверить существующий контракт). Запрос без conversationId допускается только прежним явно техническим путём; обычный пользовательский чат обязан ссылаться на доступную собственную беседу. Memory viewer read/export проверяет paidFeatures через user JWT; delete/delete_all не блокируются тарифом. Weekly endpoint проверяет доступ и paidFeatures перед генерацией.

## Клиент

Один transport для self RPC, строгая проверка safe DTO. MainScreen не select('*') и не удаляет сообщения двумя несвязанными запросами: delete RPC атомарен. Ошибки не убирают строку и показывают повтор. Закрытая карточка показывает текст «Ваши данные сохранены. Беседа будет доступна после оплаты», меню удаления остаётся. Доступность создания на free считать по can_read, не по числу архивных строк.

Обёртка защищённых экранов chat/memory/dynamics/notes проверяет серверный доступ при открытии и смене verified tier/session. На неизвестных правах содержимое не монтируется; после expiry старый компонент размонтируется, локальный transcript/stream не восстанавливаются из AppContext. Временные запросы отменяются/устаревшие результаты отбрасываются, подписка на billing/focus обновляет права. Memory/dynamics дополнительно paid, notes — только собственная доступная беседа. UI не подменяет серверный guard.

## Проверки и границы доказательств

Настоящие SQL запросы authenticated: metadata-only list; закрытый direct read summary/messages/preview/search; чужой UID; expired raw tier до quota; paid quota0; ручные/unlimited/override; free с пакетом; удаление закрытой/доступной/всех; новый empty вместо удаления; попытка resurrect старой inactive; переименование; перестановка только paid; обратная покупка открывает сохранённое; сбой оставляет UI-строку. Проверить ACL даже при широких default privileges и неизвестную billing-строку. Privacy delete не требует SELECT closed row.

Pure/controller/SSR тесты UI и локальный browser fixture desktop/390x844 без настоящего auth/БД/сети. Общий offline suite, typecheck, dummy build, Deno checks затронутых автономных helpers; старые26 ошибок графа памяти отдельно не скрывать. PGlite не заменяет local Supabase/PostgREST и независимые соединения; настоящую гонку/deadlock/долгий in-flight provider считать не проверенными до стенда. Никаких production/платных тестов или выкладки.
