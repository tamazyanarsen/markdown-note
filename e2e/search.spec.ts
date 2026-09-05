import { expect, resetTestUser, seedNote, test } from "./fixtures";

/**
 * Палитра поиска и режим ответа.
 *
 * До сих пор весь этот путь был проверен только через HTTP: что `Ctrl+K`
 * действительно перехватывается (Chrome вешает на него адресную строку),
 * что список перестраивается после паузы и что режим ответа переключается
 * туда и обратно — можно увидеть только в браузере.
 */

// Перед каждым тестом, а не один раз: заметки прошлого теста иначе
// доживают до следующего и удваиваются в выдаче.
test.beforeEach(resetTestUser);

async function seedNotes() {
  await seedNote({
    title: "ADR: доступы",
    content:
      "Владелец видит всё своё дерево целиком. Гость видит только public-заметки и папки на пути к ним. Приватная заметка не попадает в публичный ответ вообще.",
  });

  await seedNote({
    title: "Сборка в Docker",
    content: "Образ собирается в два этапа, миграции идут отдельным контейнером.",
  });
}

test("Ctrl+K открывает палитру и находит заметку", async ({ page }) => {
  await seedNotes();
  await page.goto("/");

  // Именно сочетание клавиш, а не кнопка: браузер норовит увести фокус
  // в адресную строку, и preventDefault здесь единственная защита.
  await page.keyboard.press("Control+k");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.keyboard.type("доступы");

  await expect(dialog.getByText("ADR: доступы")).toBeVisible();
  await expect(dialog.getByText("Сборка в Docker")).toHaveCount(0);

  // Выбор пункта ведёт на заметку. Кликом, а не Enter: первым в списке
  // может стоять «Спросить у заметок», и Enter означал бы вопрос,
  // а не переход — навигация стрелками проверяется отдельным тестом.
  await dialog.getByText("ADR: доступы").click();
  await expect(page).toHaveURL(/\/n\/[0-9a-f-]{36}$/);
});

test("стрелки и Enter водят по выдаче", async ({ page }) => {
  await seedNotes();
  await page.goto("/");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("заметк");

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("ADR: доступы")).toBeVisible();

  // Палитра должна работать, ни разу не тронув мышь.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/n\/[0-9a-f-]{36}$/);
});

test("палитра закрывается по Escape и забывает запрос", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("доступы");
  await page.keyboard.press("Escape");

  await expect(page.getByRole("dialog")).toBeHidden();

  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder(/Найти заметку/)).toHaveValue("");
});

test("на время ожидания ответа висит индикатор, потом ответ и источники", async ({
  page,
}) => {
  await seedNotes();

  // Ответ подставной и намеренно медленный. Иначе индикатор не проверить:
  // настоящая модель отвечает за секунды, но может ответить и мгновенно,
  // и тогда утверждение «индикатор виден» проваливалось бы через раз —
  // тест на переходное состояние обязан это состояние удерживать сам.
  await page.route("**/api/ask", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await route.fulfill({
      json: {
        answer: "Владелец видит всё своё дерево, гость — только public [1].",
        sources: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            title: "ADR: доступы",
            folderId: null,
            snippet: "Владелец видит всё своё дерево целиком.",
          },
        ],
      },
    });
  });

  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("кто имеет право видеть записи");

  const dialog = page.getByRole("dialog");
  await dialog.getByText("Спросить у заметок").click();

  await expect(dialog.getByRole("status")).toContainText("Читаю заметки");

  await expect(dialog.getByText("Источники")).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await expect(dialog.locator("article")).toContainText("Владелец видит");

  // Возврат к поиску: список снова на месте, ответ забыт.
  await dialog.getByRole("button", { name: "К поиску" }).click();
  await expect(dialog.getByPlaceholder(/Найти заметку/)).toBeVisible();
  await expect(dialog.getByText("Источники")).toHaveCount(0);
});

test("настоящая модель отвечает по заметкам, а не из общих знаний", async ({
  page,
}) => {
  // Единственный тест, который ходит в живой MWS и стоит денег.
  test.skip(
    !process.env.MWS_API_KEY || !process.env.MWS_CHAT_MODEL,
    "MWS_API_KEY или MWS_CHAT_MODEL не заданы",
  );

  await seedNotes();
  await page.goto("/");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("кто имеет право видеть записи");

  const dialog = page.getByRole("dialog");
  await dialog.getByText("Спросить у заметок").click();

  // 45 секунд — потолок ожидания в src/lib/chat.ts.
  await expect(dialog.getByText("Источники")).toBeVisible({ timeout: 60_000 });

  // Именно сгенерированный ответ, а не деградация. Без этой проверки тест
  // прошёл бы и при отказе модели: источники показываются в обоих случаях,
  // и «зелёный» ничего не значил бы.
  await expect(dialog.getByText(/Пересказ не получился/)).toHaveCount(0);

  const answer = dialog.locator("article");
  await expect(answer).toBeVisible();

  // Ответ должен опираться на заметку, а не пересказывать общие места:
  // роли из неё — владелец и гость.
  await expect(answer).toContainText(/владел/i);
  await expect(answer).toContainText(/гост/i);

  // Источником должна оказаться именно та заметка, в которой ответ есть.
  await expect(
    dialog.getByRole("button").filter({ hasText: "ADR: доступы" }),
  ).toBeVisible();
});
