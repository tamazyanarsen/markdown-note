import "dotenv/config";

import { test as base, expect, type Page } from "@playwright/test";
import { Client } from "pg";

/**
 * Общая обвязка браузерных тестов.
 *
 * Вход через OAuth в тесте не пройти: провайдер живой и внешний. Вместо этого
 * сессия кладётся прямо в таблицу `sessions` — она и так лежит в базе, а не
 * в JWT, так что подделывать нечего, строка настоящая. Ровно за это свойство
 * database-сессий держится и README, раздел «Почему нет входа по паролю».
 */

/** Отдельный пользователь под тесты: чужие данные они не трогают. */
export const TEST_USER_ID = "d0e2e000-0000-4000-8000-d0e2e0000000";
const TEST_EMAIL = "e2e@example.com";

/** Имя cookie для http-локалхоста; на https Auth.js берёт __Secure-префикс. */
const SESSION_COOKIE = "authjs.session-token";
const SESSION_TOKEN = "e2e-session-token";

/**
 * Отдельное соединение на каждый вызов, а не общий пул.
 *
 * Пул пришлось бы закрывать, а модуль общий на все spec-файлы одного
 * воркера: первый же закрывший ломал бы остальные. Подготовка данных
 * идёт раз в тест, лишнее подключение на её фоне не считается.
 */
async function withDb(run: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await run(client);
  } finally {
    await client.end();
  }
}

export async function resetTestUser(): Promise<void> {
  await withDb(async (client) => {
    // Каскад по owner_id уносит и заметки, и связи, и вложения предыдущего
    // теста: каждый начинается с пустого дерева.
    await client.query("delete from users where id = $1", [TEST_USER_ID]);

    await client.query(
      `insert into users (id, display_name, email, is_approved)
       values ($1, 'E2E', $2, true)`,
      [TEST_USER_ID, TEST_EMAIL],
    );

    await client.query(
      `insert into sessions (session_token, user_id, expires)
       values ($1, $2, now() + interval '1 day')`,
      [SESSION_TOKEN, TEST_USER_ID],
    );
  });
}

/** Тест с уже авторизованным контекстом. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: SESSION_TOKEN,
        domain: "localhost",
        path: "/",
      },
    ]);

    await use(context);
  },
});

export { expect };

/**
 * Заметка-декорация: кладётся прямо в базу, мимо приложения.
 *
 * Так делается всё, что тесту нужно только как фон — чтобы поиску было что
 * находить, а панели связей что показывать. Гонять такое через API нельзя:
 * rate limit на изменения считает 60 запросов в минуту, и несколько прогонов
 * подряд упирались в собственный же 429. Лимит при этом правильный,
 * чинить надо не его.
 *
 * Там, где проверяется как раз доменная логика сохранения (связи из текста),
 * нужен createNote — он идёт через настоящий эндпоинт.
 */
export async function seedNote(input: {
  title: string;
  content?: string;
}): Promise<string> {
  let id = "";

  await withDb(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into notes (owner_id, folder_id, title, content)
       values ($1, null, $2, $3)
       returning id`,
      [TEST_USER_ID, input.title, input.content ?? ""],
    );

    id = result.rows[0].id;
  });

  return id;
}

/**
 * Создаёт заметку настоящим запросом к API.
 *
 * Нужен там, где важны производные от текста — связи считает updateNote
 * и createNote в доменном слое, и вставка в обход них ничего бы не проверила.
 */
export async function createNote(
  page: Page,
  input: { title: string; content?: string },
): Promise<string> {
  const response = await page.request.post("/api/notes", {
    data: { title: input.title, folderId: null, content: input.content ?? "" },
  });

  // С телом ответа: «ok = false» без кода и сообщения ничего не объясняет,
  // а упасть здесь можно и на лимите запросов, и на валидации.
  expect(
    response.ok(),
    `POST /api/notes → ${response.status()} ${await response.text()}`,
  ).toBeTruthy();

  return (await response.json()).id as string;
}

/** Текст в редакторе CodeMirror. */
export async function editorText(page: Page): Promise<string> {
  return page.locator(".cm-content").innerText();
}

/**
 * Дождаться, что автосохранение доехало.
 *
 * По тексту, а не по role=status: живая область dnd-kit объявлена тем же
 * role и висит в корне страницы, так что поиск по роли находит два элемента.
 */
export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();
}
