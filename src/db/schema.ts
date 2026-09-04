import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

/**
 * Схема соответствует docs/описание.md со следующими отличиями:
 *  - notes.content хранит markdown-исходник (text), а не документ ProseMirror (jsonb);
 *  - вместо notes.plain_text — генерируемая колонка notes.search_vector;
 *  - users.email nullable: VK не отдаёт email, у GitHub он может быть скрыт;
 *  - добавлены таблицы Auth.js (accounts / sessions / verification_tokens).
 *
 * Имена колонок выводятся из имён свойств через casing: "snake_case"
 * (drizzle.config.ts и src/db/client.ts). Явное имя указано только там,
 * где свойство и колонка расходятся.
 */

// citext и tsvector в drizzle нет — объявляем их сами.
const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

const tsvector = customType<{ data: string }>({
  dataType: () => "tsvector",
});

export const noteVisibility = pgEnum("note_visibility", ["private", "public"]);

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

// --- Пользователи и Auth.js -------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),

    // Auth.js обращается к этому полю как к `name`.
    name: text("display_name"),
    email: citext(),
    emailVerified: timestamp({ withTimezone: true, mode: "date" }),
    image: text(),

    // Allowlist: сервис публичный, но вход — только для одобренных.
    isApproved: boolean().notNull().default(false),

    ...timestamps,
  },
  (t) => [
    // Уникальность только среди непустых email: у VK-пользователя email нет.
    uniqueIndex("users_email_key")
      .on(t.email)
      .where(sql`${t.email} is not null`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().$type<AdapterAccountType>().notNull(),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    // Имена ниже — snake_case на уровне свойств: Auth.js кладёт сюда
    // ответ токен-эндпоинта как есть, поэтому переименовывать нельзя.
    refresh_token: text(),
    access_token: text(),
    expires_at: integer(),
    token_type: text(),
    scope: text(),
    id_token: text(),
    session_state: text(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text().notNull(),
    token: text().notNull(),
    expires: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

// --- Дерево -----------------------------------------------------------------

export const folders = pgTable(
  "folders",
  {
    id: uuid().primaryKey().defaultRandom(),

    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    parentId: uuid().references((): AnyPgColumn => folders.id, {
      onDelete: "cascade",
    }),

    title: text().notNull(),

    // Дробная сортировка: новая позиция — среднее между соседями.
    // См. src/lib/position.ts, там же ребалансировка ветки.
    position: numeric({ precision: 20, scale: 10 }).notNull().default("1000"),

    isArchived: boolean().notNull().default(false),

    ...timestamps,
  },
  (t) => [
    check("folders_cannot_be_own_parent", sql`${t.id} <> ${t.parentId}`),

    index("folders_parent_position_idx")
      .on(t.parentId, t.position)
      .where(sql`${t.isArchived} = false`),

    index("folders_owner_parent_position_idx")
      .on(t.ownerId, t.parentId, t.position)
      .where(sql`${t.isArchived} = false`),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid().primaryKey().defaultRandom(),

    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // set null: удаление папки не должно уносить заметки в никуда —
    // они всплывают в корень личного дерева.
    folderId: uuid().references(() => folders.id, { onDelete: "set null" }),

    title: text().notNull(),

    visibility: noteVisibility().notNull().default("private"),

    // Markdown-исходник. Рендерится на сервере, см. src/lib/markdown.ts.
    content: text().notNull().default(""),

    // Кеш рендера для публичной страницы /n/:id: unified-пайплайн стоит
    // дороже, чем сам запрос за заметкой, а результат между правками
    // не меняется. null означает «надо отрендерить»; сбрасывается в null
    // при каждом изменении content (см. updateNote в src/domain/notes.ts).
    // Наружу не отдаётся: в API и в пропсах редактора есть тот же текст
    // в виде markdown, дублировать его html-версией незачем.
    contentHtml: text(),

    position: numeric({ precision: 20, scale: 10 }).notNull().default("1000"),

    isArchived: boolean().notNull().default(false),

    ...timestamps,

    // to_tsvector с явной конфигурацией immutable, поэтому годится
    // для generated-колонки. Заменяет plain_text из документа.
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('russian', coalesce(${notes.title}, '') || ' ' || coalesce(${notes.content}, ''))`,
    ),
  },
  (t) => [
    index("notes_folder_position_idx")
      .on(t.folderId, t.position)
      .where(sql`${t.isArchived} = false`),

    index("notes_public_folder_position_idx")
      .on(t.folderId, t.position)
      .where(sql`${t.visibility} = 'public' and ${t.isArchived} = false`),

    index("notes_owner_idx")
      .on(t.ownerId)
      .where(sql`${t.isArchived} = false`),

    index("notes_search_idx").using("gin", t.searchVector),
  ],
);

// --- Семантический поиск ----------------------------------------------------

/**
 * Размерность вектора модели bge-m3 (MWS GPT Model Hub).
 *
 * Зашита в тип колонки, поэтому смена модели — это миграция плюс полная
 * переиндексация. Держать её здесь, а не в переменной окружения, намеренно:
 * иначе рассогласование конфига и базы вылезало бы ошибкой на каждой вставке.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Куски заметок и их векторы.
 *
 * chunkIndex почти всегда 0: в окно модели (8192 токена) помещается почти
 * любая заметка. Колонка заведена сразу, чтобы нарезка длинных заметок не
 * требовала миграции — заметка может быть до 512 КБ (LIMITS.contentMaxLength).
 *
 * HNSW-индекса нет намеренно: на текущих объёмах полный перебор быстрее
 * обхода индекса. Добавляется одной строкой, когда векторов станут тысячи.
 */
export const noteChunks = pgTable(
  "note_chunks",
  {
    noteId: uuid()
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),

    chunkIndex: integer().notNull(),

    // md5(title || content) на момент расчёта вектора. Разошёлся с текущим
    // содержимым — значит заметку надо переиндексировать. Отдельного флага
    // «устарело» нет специально: флаг можно рассинхронизировать с данными,
    // а хеш — нет. Тот же приём, что у contentHtml, только самопроверяемый.
    sourceHash: text().notNull(),

    // Очищенный от markdown текст: он же уходит в модель, он же показывается
    // в выдаче как сниппет. Хранится копией, а не смещениями в notes.content:
    // смещения разъезжались бы в окне между правкой и переиндексацией.
    text: text().notNull(),

    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.chunkIndex] })],
);

export type User = typeof users.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type NoteChunk = typeof noteChunks.$inferSelect;

/**
 * Заметка в том виде, в каком она уходит наружу — в JSON API и в пропсы
 * редактора. Без contentHtml (кеш рендера нужен только серверу) и без
 * searchVector (служебный tsvector, который клиенту не пригодится).
 * Проекция, дающая этот тип, — noteColumns в src/domain/notes.ts.
 */
export type NoteView = Omit<Note, "contentHtml" | "searchVector">;
export type NoteVisibility = (typeof noteVisibility.enumValues)[number];
