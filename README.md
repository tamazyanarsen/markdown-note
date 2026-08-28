# md-note

Личное дерево заметок в markdown с постоянными ссылками на папки и заметки.

Доменная модель, схема БД и правила доступа описаны в
[`docs/описание.md`](docs/описание.md) — это источник истины.
Расхождения реализации с документом перечислены в конце этого файла.

Что сделано, что проверено и что осталось —
[`docs/следующие-шаги.md`](docs/следующие-шаги.md).

## Как это работает

Два вида ресурсов, у каждого — UUID, который одновременно первичный ключ
и идентификатор в ссылке:

```
/f/:folderId    папка
/n/:noteId      заметка
```

Заметка бывает `private` или `public`. У папки собственной видимости нет.

| Кто открывает | `/n/:id` private | `/n/:id` public | `/f/:id` |
| :-- | :-- | :-- | :-- |
| Владелец | заметка | заметка | всё поддерево |
| Гость | `404` | заметка | только public-заметки и папки на пути к ним |
| Другой пользователь | `404` | заметка | то же, что гость |

Private-заметка не попадает в публичный ответ вообще: ни UUID, ни заголовок,
ни время изменения.

## Стек

Next.js 16 (App Router, TypeScript) · PostgreSQL 17 · Drizzle ORM ·
Auth.js v5 (GitHub / Яндекс / VK ID) · CodeMirror 6 · remark/rehype ·
dnd-kit · Tailwind CSS 4 · Docker Compose за nginx

## Локальный запуск

```bash
cp .env.example .env          # заполнить AUTH_SECRET: npx auth secret
npm install
npm run db:up                 # Postgres в Docker
npm run db:migrate            # схема, индексы, триггеры
npm run dev
```

Без OAuth-приложений страница входа скажет, что провайдеров нет. Заведи хотя бы
GitHub: https://github.com/settings/developers, callback
`http://localhost:3000/api/auth/callback/github`.

### Команды

| Команда | Что делает |
| :-- | :-- |
| `npm run dev` | dev-сервер |
| `npm run typecheck` | генерация типов роутов + `tsc --noEmit` |
| `npm test` | vitest: юнит-тесты и интеграционные (нужен `db:up`) |
| `npm run db:generate` | сгенерировать миграцию по изменённой схеме |
| `npm run db:migrate` | применить миграции |
| `npm run db:psql` | psql в контейнер |
| `npm run db:studio` | drizzle studio |

Триггеры, partial-индексы и расширения дописываются в сгенерированный
`.sql` руками — `drizzle-kit` их не выводит из схемы.

## Устройство

```
src/
├─ app/
│  ├─ (страницы) /, /signin, /pending, /f/[folderId], /n/[noteId]
│  └─ api/…                    эндпоинты из раздела «API» документа
├─ db/
│  ├─ schema.ts                Drizzle-схема
│  ├─ client.ts                пул соединений
│  └─ queries/tree.ts          дерево владельца и публичная проекция
├─ domain/                     use cases: здесь живут проверки владения
│  ├─ folders.ts  notes.ts  move.ts
├─ lib/
│  ├─ auth.ts  session.ts      Auth.js, requireUser()
│  ├─ markdown.ts              remark/rehype + санитизация
│  ├─ position.ts              дробная сортировка
│  ├─ errors.ts                доменные ошибки → HTTP-коды
│  └─ rate-limit.ts
└─ components/
```

Правило слоёв: route handler занимается только HTTP, все проверки прав — в
`src/domain`. Ни один запрос на изменение не ищет ресурс по одному лишь `id`,
всегда по паре `(id, owner_id)`.

## Доступ

Вход через OAuth открыт всем, но приложение доступно только одобренным.
`ALLOWED_EMAILS` — список email через запятую, которым доступ выдаётся
автоматически при первом входе. Остальные попадают на `/pending`; одобрить
их можно вручную:

```sql
update users set is_approved = true where id = '…';
```

Если `ALLOWED_EMAILS` пуст, регистрация открыта — это режим локальной
разработки, для публичного сервера переменную нужно заполнить.

### Почему нет входа по паролю

Сознательное решение. Credentials-провайдер Auth.js несовместим с
database-сессиями: он всегда кладёт в cookie JWT и не создаёт строку в
`sessions`. Добавить пароль — значит перевести всё приложение на JWT и
потерять отзыв сессий (`delete from sessions`) и актуальность `is_approved`,
который сейчас читается из базы, а не протухает в токене на 30 дней.

Если понадобится вход для человека без Яндекса, VK и GitHub — это magic link,
а не пароль: он работает с database-сессиями, а таблица `verification_tokens`
под него уже есть в схеме. Из нового нужен только SMTP или Resend.

## Деплой

Пошаговая инструкция для чистого сервера — [`docs/деплой.md`](docs/деплой.md).
Коротко:

```bash
cp .env.production.example .env.production   # заполнить пароли, AUTH_URL, OAuth
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Compose поднимает Postgres, одноразовый контейнер миграций (приложение
стартует только после его успешного выхода) и само приложение.

Наружу не смотрит ничего: Postgres доступен только внутри сети compose,
приложение — на `127.0.0.1:3000`. TLS и 80/443 держит системный nginx:
настройки прокси — [`deploy/md-note-proxy.conf`](deploy/md-note-proxy.conf),
готовый `server`-блок для своего домена —
[`deploy/md-note.nginx.conf`](deploy/md-note.nginx.conf). Если домен на
сервере уже настроен и сертификат выпущен, нужен только первый файл.

Бэкапы — `scripts/backup.sh`, в cron на хосте:

```
0 4 * * * /opt/md-note/scripts/backup.sh >> /var/log/md-note-backup.log 2>&1
```

## Отличия от docs/описание.md

Документ писался под редактор Tiptap и обязательный email. Реализация
расходится с ним в четырёх местах:

1. `notes.content` — `text` с markdown-исходником, а не `jsonb`.
2. Вместо `notes.plain_text` — генерируемая колонка `search_vector` (`tsvector`)
   с GIN-индексом.
3. `users.email` — nullable: VK не отдаёт email, у GitHub он может быть скрыт.
   Уникальность даёт пара провайдер + внешний id.
4. Добавлены таблицы Auth.js: `accounts`, `sessions`, `verification_tokens`.

Остальное — инварианты владения, триггеры, правила перемещения, коды ошибок
и публичная проекция дерева — соответствует документу.
