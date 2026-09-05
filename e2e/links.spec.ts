import {
  createNote,
  editorText,
  expect,
  expectSaved,
  resetTestUser,
  seedNote,
  test,
} from "./fixtures";

/**
 * Wiki-ссылки и панель связей.
 *
 * Автодополнение по `[[` целиком клиентское: источник дополнений CodeMirror,
 * запрос в /api/search и подстановка markdown-ссылки. Доменными тестами это
 * не проверяется никак.
 */

// Перед каждым тестом, а не один раз: заметки прошлого теста иначе
// доживают до следующего и попадают в его выдачу.
test.beforeEach(resetTestUser);

test("`[[` подставляет ссылку на заметку, и у цели появляется бэклинк", async ({
  page,
}) => {
  const targetId = await seedNote({
    title: "Дробная сортировка",
    content: "position numeric(20,10), новое значение — среднее между соседями.",
  });

  const sourceId = await seedNote({ title: "Черновик" });

  await page.goto(`/n/${sourceId}`);

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.click();

  // Ждём, что редактор действительно принял фокус. Без этого на холодной
  // компиляции первые нажатия улетают в никуда, `[[` не набирается целиком
  // и список дополнений не появляется вовсе — тест падал через раз.
  await expect(editor).toBeFocused();

  await page.keyboard.type("Смотри [[дробная");
  await expect.poll(() => editorText(page)).toContain("[[дробная");

  // Список появляется после запроса к /api/search — ждём именно его,
  // а не таймаут.
  const suggestion = page.locator(".cm-tooltip-autocomplete li", {
    hasText: "Дробная сортировка",
  });
  await expect(suggestion).toBeVisible();

  await page.keyboard.press("Enter");

  // В файл уходит обычная markdown-ссылка на permalink, а не `[[…]]`.
  // Проверяем текст целиком: closeBrackets дописывает `]]` за `[[`,
  // и хвост от них не должен остаться в заметке.
  await expect
    .poll(() => editorText(page))
    .toBe(`Смотри [Дробная сортировка](/n/${targetId})`);

  await expectSaved(page);

  // Обратная сторона связи: у цели появилась строка «Ссылаются сюда».
  await page.goto(`/n/${targetId}`);

  const backlinks = page.getByRole("list", { name: "Ссылаются сюда" });
  await expect(backlinks.getByRole("link", { name: "Черновик" })).toBeVisible();
});

test("ссылка в блоке кода связью не становится", async ({ page }) => {
  const targetId = await seedNote({ title: "Цель для кода" });

  await createNote(page, {
    title: "Документация",
    content: ["Пример:", "", "```md", `[цель](/n/${targetId})`, "```"].join("\n"),
  });

  await page.goto(`/n/${targetId}`);

  // Панель целиком не рисуется, когда связей нет: пустой блок отнимал бы
  // высоту у редактора ни за что.
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByRole("list", { name: "Ссылаются сюда" })).toHaveCount(0);
});

test("похожие заметки находятся по смыслу, а не по словам", async ({ page }) => {
  // Ходит в настоящий MWS за векторами. Без ключа блок просто не появится,
  // и тест это отметит как пропуск, а не как провал.
  test.skip(!process.env.MWS_API_KEY, "MWS_API_KEY не задан");

  const sourceId = await seedNote({
    title: "Порядок элементов в дереве",
    content:
      "Позиция хранится как numeric(20,10). Новая позиция — среднее между соседями, при слишком малом зазоре ветка ребалансируется.",
  });

  await seedNote({
    title: "Перетаскивание",
    content:
      "Заметку можно перенести мышью между папками, порядок внутри уровня при этом сохраняется.",
  });

  await page.goto(`/n/${sourceId}`);

  const related = page.getByRole("list", { name: "Похожие" });

  // Первый заход считает векторы во внешнем API — это заметно дольше
  // обычного запроса, поэтому ждём дольше обычного.
  await expect(related).toBeVisible({ timeout: 45_000 });
  await expect(related.getByRole("link", { name: "Перетаскивание" })).toBeVisible();
});
