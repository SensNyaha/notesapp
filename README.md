# Tasks

Локально развёртываемая PWA для заметок, напоминаний и планирования со сквозным шифрованием содержимого.

Текущая рабочая версия: **0.14.0**, SQLite schema **12**. Сервер и PWA слушают порт **3100**. Полная карта документации находится в [`docs/README.md`](docs/README.md), фактическое покрытие функций — в [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md), дальнейший порядок разработки — в [`TODO.md`](TODO.md).

## Что работает

- первый администратор через ENV либо подтверждённый первый вход;
- создание пользователей администратором через UI и CLI;
- временные пароли на 48 часов, обязательная смена, access/refresh-сессии и управление устройствами;
- WebAuthn Passkey как дополнительный способ входа при сохранении независимого входа по логину и паролю;
- несколько независимых E2EE-хранилищ с phrase unlock и сохранённой legacy-разблокировкой;
- опциональная системная разблокировка конкретного vault через WebAuthn PRF: encrypted root-key wrapper хранится локально, готовый root key — только в runtime;
- ручная блокировка и background auto-lock защищённого vault: никогда / 1 / 5 / 15 / 30 / 60 минут;
- локальное закрытие и закрытие хранилища на всех устройствах;
- форматированные заметки, чек-листы, небольшие встроенные вложения, теги и закрепление;
- разделённые просмотр и редактирование заметки;
- локальный релевантный поиск с умеренной нечёткостью и сортировкой по дате;
- offline-first IndexedDB, outbox, неизменяемые ревизии, конфликты и зашифрованный стеш;
- безопасный разбор накопленного outbox после отзыва сессии и повторного входа без слепой автоматической отправки;
- разовые и повторяющиеся напоминания, экран «Сегодня», snooze и история срабатываний;
- Web Push на все активные устройства аккаунта и повтор непросмотренного события;
- архив, корзина на 30 дней, окончательное удаление и история версий;
- открытые названия закрытых хранилищ и диагностика свободного места для администратора;
- транзакционные миграции, WAL-aware backup/restore и автоматические проверки.
Архив, корзина, история и расширенные повторяющиеся напоминания реализованы, но их реальные сценарии на установленной PWA ещё отмечены как требующие пользовательской приёмки.

## Требования

- Node.js **24.x**;
- Docker с Compose V2 для штатного локального запуска;
- современный браузер с Web Crypto и IndexedDB;
- WebAuthn для Passkey; WebAuthn PRF требуется только для криптографической системной разблокировки E2EE-хранилища;
- HTTPS для установленной PWA и настоящего Web Push на iPhone.

Проверенный публичный адрес обслуживает владелец установки: `https://notesapp.sensnyaha.ru`. Репозиторий не управляет его reverse proxy, сертификатами и деплоем.

## Настройка

Скопируйте `.env.example` в `.env`. Файл `.env` исключён из Git.

```dotenv
APP_ORIGIN=http://localhost:3100
AUTH_COOKIE_MODE=localhost
BOOTSTRAP_ADMIN_LOGIN=
BOOTSTRAP_ADMIN_PASSWORD=
```

Для HTTPS задаются точный origin и защищённые cookie:

```dotenv
APP_ORIGIN=https://example.org
AUTH_COOKIE_MODE=secure
```

Первый администратор создаётся одним из способов:

- обе переменные `BOOTSTRAP_ADMIN_LOGIN` и `BOOTSTRAP_ADMIN_PASSWORD` заданы — сервер создаёт admin до приёма HTTP-запросов;
- обе пусты — первый вход при пустой базе показывает предупреждение, требует повторить пароль и создаёт admin;
- задана только одна переменная либо значение не проходит проверку — запуск останавливается.

После появления хотя бы одного аккаунта bootstrap-переменные больше не меняют пользователей и пароль. Их можно удалить из окружения и пересоздать контейнер.

Логин содержит 3–32 ASCII-символа, начинается с латинской буквы; далее разрешены буквы, цифры, точка, дефис и подчёркивание. Регистр логина не различается. Пароль аккаунта содержит 6–128 Unicode-символов, минимум одну цифру, одну заглавную и одну строчную букву. Фраза хранилища содержит минимум 6 любых символов.

## Локальный запуск в Docker

Обычная сборка без дополнительного CA:

```powershell
docker compose up -d --build
docker compose ps
curl.exe -fsS http://localhost:3100/api/health
```

Если сеть подменяет сертификат npm, используйте существующий CA override:

```powershell
docker compose -f compose.yaml -f compose.ca.yaml up -d --build
docker compose -f compose.yaml -f compose.ca.yaml ps
```

Подготовка сертификата описана в [`docs/NPM_CA.md`](docs/NPM_CA.md). Проверка TLS не отключается.

Для локальной отладки всегда пересобирается существующий сервис `app` и тот же volume. Не создавайте параллельный тестовый контейнер и не удаляйте volume. Dockerfile запускает typecheck, production build и все тесты до создания runtime-образа; при ошибке текущий рабочий контейнер остаётся доступен.

Полезные команды:

```powershell
docker compose logs --tail 100 app
docker compose restart app
docker compose stop app
```

Ожидаемый health текущей версии содержит `status: ok`, `version: 0.14.0`, `database: ok`, постоянный `installationId`, `bootCount` и время сервера.

## Запуск без Docker

```powershell
npm ci
npm run build
npm run check
node --env-file=.env server/index.mjs
```

По умолчанию сервер слушает `127.0.0.1:3100`, а БД хранится в `./data`. Путь можно изменить переменной `DATA_DIR`, адрес — `HOST` и `PORT`.

## Проверки

```powershell
npm run typecheck
npm run build
npm run check
```

`npm run build` уже включает typecheck, Vite production build и создание Service Worker. На версии **0.14.0** проходят **79 тестов**. Они проверяют сервер, миграции, password/Passkey authentication, сессии, WebAuthn challenge/replay/origin/RP ID/UV, PRF-wrapper и auto-lock lifecycle, шифрование, хранилища, синхронизацию, поиск, напоминания, push и PWA shell.

Автоматические проверки не заменяют проверку установленной PWA, Safari, реальной доставки push и адаптивных экранов. Тестовый push при закрытой PWA ранее подтверждён пользователем на iOS 26.6.1.

## Обновление существующего контейнера

Если новая версия меняет SQLite schema, до сборки создайте backup работающей БД. Затем пересоберите существующий сервис:

```powershell
docker compose -f compose.yaml -f compose.ca.yaml up -d --build
docker compose -f compose.yaml -f compose.ca.yaml ps
curl.exe -fsS http://localhost:3100/api/health
docker compose -f compose.yaml -f compose.ca.yaml logs --tail 100 app
```

Если дополнительный CA не нужен, уберите `-f compose.ca.yaml`. Не запускайте старую версию приложения на БД с более новой схемой: для отката кода восстановите совместимый backup.

После обновления установленной PWA откройте её онлайн. Если приложение сообщает о новой оболочке, примените обновление и перезапустите PWA.

## Резервное копирование и восстановление

Каталоги `data/` и `backups/` исключены из Git. Backup содержит хеши аккаунтов, серверные сессии, открытые служебные метаданные и зашифрованные пользовательские записи, поэтому доступ к нему нужно ограничивать.

Создать согласованный SQLite-снимок внутри volume:

```powershell
docker compose exec -T app node server/cli/backup.mjs /data/tasks.sqlite /data/tasks-backup.sqlite
```

Скопировать его на хост:

```powershell
New-Item -ItemType Directory -Force -Path .\backups | Out-Null
$tasksContainerId = docker compose ps -q app
docker cp "${tasksContainerId}:/data/tasks-backup.sqlite" .\backups\tasks-backup.sqlite
```

Проверить и подготовить восстановление в новый пустой каталог:

```powershell
docker compose exec -T app node server/cli/restore.mjs /data/tasks-backup.sqlite /data/restored
```

Команда восстановления не перезаписывает существующий каталог. Переключение `DATA_DIR` и откат версии выполняются только после проверки совместимости schema. Git сам по себе не восстанавливает SQLite, WAL, IndexedDB или Docker volume.

Проверенные контрольные снимки перед миграциями хранятся в игнорируемой папке `backups/`: перед schema 10 — `before-stage13-schema10-20260914.sqlite` (SHA-256 `6CAF1A76AB5E127C3CC581BCEA2F511CD4882D95B3139328EF96954193A8468C`), перед schema 11 — `before-stage14b-schema11-20260917.sqlite` (SHA-256 `97B156375076D710B047E69ADE68B9E460DC2FE3294E14692FB9689BEF541F1D`), перед schema 12 / версией 0.14.0 — `before-stage14c-schema12-20260917.sqlite` (SHA-256 `92153DF4FCB669BD0D4EA161B94C0C8F7E69BDE6C5CEE7DC1C5163C250F8B91F`).

## Команды администратора

CLI требует интерактивный терминал. Пароль не передаётся аргументом, ENV или pipe; ручной ввод скрыт и требует повтора. `--generate` создаёт пароль и выводит его один раз.

```powershell
docker compose exec app npm run user:create -- seconduser
docker compose exec app npm run user:create -- seconduser --generate
docker compose exec app npm run user:reset -- seconduser --generate
docker compose exec app npm run admin:recover -- adminlogin --generate
```

`user:create` создаёт только обычного пользователя и не инициализирует пустую установку. `user:reset` работает с обычным пользователем, `admin:recover` — с существующим администратором. Новый временный пароль действует 48 часов и отзывает старые сессии целевого аккаунта.

## Безопасность и приватность

- Пароли аккаунта хешируются Argon2id: 64 МиБ, `t=3`, `p=1`.
- WebAuthn Passkey — дополнительный способ входа; пароль не отключается и остаётся независимым fallback.
- WebAuthn требует user verification, проверку challenge/origin/RP ID/signature и создаёт обычную access/refresh-сессию.
- Access-cookie живёт 15 минут; refresh продлевается до 30 дней без активности, абсолютный предел семейства — 90 дней.
- Cookie — HttpOnly и SameSite=Strict; HTTPS использует Secure и префикс `__Host-`.
- Изменяющие запросы защищены exact-origin, JSON и CSRF-токеном.
- Фраза, root key хранилища и WebAuthn PRF output не отправляются серверу.
- Сервер хранит непрозрачные зашифрованные ревизии. Открытыми являются необходимые ID, расписание доставки, явно разрешённый push-текст, название хранилища и lifecycle корзины.
- Сброс пароля аккаунта не расшифровывает хранилища.
- Потерянную фразу нельзя восстановить на сервере. Перенос возможен только с устройства, где ключ ещё доступен.
- Поиск выполняется на клиенте по расшифрованным данным открытых хранилищ.
- Окончательно удалённый объект получает постоянный tombstone, чтобы старое офлайн-устройство не воскресило его.

Текущий JSON-формат ревизии ограничен одним мегабайтом, поэтому встроенные MVP-вложения ограничены 512 КБ. Это временное техническое ограничение. Для конечного продукта запланирован отдельный поток зашифрованных частей без фиксированного продуктового лимита размера файла; загрузку будет ограничивать фактическое свободное место сервера.

## Структура проекта

```text
src/                     Preact-клиент, IndexedDB, синхронизация и Web Crypto
src/components/          пользовательские экраны
src/crypto/              форматы E2EE
server/                  Fastify, SQLite, маршруты, workers и CLI
tests/                   Node test runner и интеграционные проверки
scripts/build-sw.mjs     сборка Service Worker
docs/                    требования, архитектура, решения и макеты
compose.yaml             единственный локальный Compose-сервис app
compose.ca.yaml          BuildKit secret с дополнительным npm CA
Dockerfile               проверяемая многостадийная production-сборка
```

`docs/` и `TODO.md` намеренно исключены из Git и остаются локальными рабочими материалами. `README.md` отслеживается Git. Пользователь самостоятельно выполняет commit, push и серверный деплой.
