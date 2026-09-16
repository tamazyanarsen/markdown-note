import { createNote, expect, resetTestUser, seedNote, test } from "./fixtures";

/**
 * Карта связей.
 *
 * Холст не проверяется доменными тестами никак: сборка узлов — чистая
 * функция (src/lib/graph.test.ts), выборка — Postgres (tests/graph.test.ts),
 * а вот попадает ли всё это на страницу и открывается ли заметка кликом,
 * видно только из браузера.
 *
 * Содержимое самого холста прочитать нельзя — там пиксели. Поэтому
 * проверяется то, что читаемо: список-двойник рядом с ним. Он же
 * единственный способ дойти до заметки с клавиатуры, так что проверять
 * надо именно его.
 */

test.beforeEach(resetTestUser);

test("связанные заметки попадают на карту, и по ней можно перейти", async ({
  page,
}) => {
  const targetId = await seedNote({ title: "Дробная сортировка" });

  // Через API, а не seedNote: связь считает доменный слой при сохранении,
  // вставка мимо него ничего бы в граф не положила.
  await createNote(page, {
    title: "Черновик",
    content: `Подробности — в [дробной сортировке](/n/${targetId}).`,
  });

  await page.goto("/graph");

  await expect(page.getByRole("heading", { name: "Карта связей" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Карта связей между заметками" })).toBeVisible();

  await page.getByText("Те же связи списком").click();

  // Именно в списке карты: дерево в боковой панели — тоже список,
  // и те же заголовки лежат и там.
  const list = page.getByRole("list", { name: "Связи заметок" });

  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("Черновик");

  await list.getByRole("link", { name: "Дробная сортировка" }).click();

  await expect(page).toHaveURL(`/n/${targetId}`);
});

test("без единой связи карта не рисуется, а несвязанные показываются тумблером", async ({
  page,
}) => {
  await seedNote({ title: "Одинокая" });

  await page.goto("/graph");

  await expect(page.getByText("Показывать нечего")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toHaveCount(0);

  // Заметка не потерялась: она числится среди несвязанных, и её видно,
  // если попросить.
  const isolated = page.getByRole("checkbox", { name: "Без связей (1)" });
  await expect(isolated).toBeVisible();
  await isolated.check();

  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toBeVisible();

  await page.getByText("Те же связи списком").click();
  await expect(
    page.getByRole("list", { name: "Связи заметок" }).getByRole("listitem"),
  ).toHaveCount(1);
});

test("тумблер папок убирает слой, не перезагружая страницу", async ({ page }) => {
  const created = await page.request.post("/api/folders", {
    data: { title: "Рабочее", parentId: null },
  });
  expect(created.ok()).toBeTruthy();
  const folderId = (await created.json()).id as string;

  const noteId = await createNote(page, { title: "Внутри" });
  const moved = await page.request.post(`/api/notes/${noteId}/move`, {
    data: { targetFolderId: folderId },
  });
  expect(moved.ok()).toBeTruthy();

  await page.goto("/graph");
  await page.getByText("Те же связи списком").click();

  const list = page.getByRole("list", { name: "Связи заметок" });
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await page.getByRole("checkbox", { name: "Папки" }).uncheck();

  // Без слоя папок связи не остаётся вовсе: заметка становится одиночкой,
  // а сама папка с карты исчезает.
  await expect(page.getByText("Показывать нечего")).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(0);
});

test("выбранные слои переживают уход с карты и возврат", async ({ page }) => {
  // Ровно тот путь, на котором сброс и мешает: с карты кликают в заметку,
  // возвращаются — и тумблеры стоят там, где их оставили.
  const targetId = await seedNote({ title: "Дробная сортировка" });
  await createNote(page, {
    title: "Черновик",
    content: `[дробная сортировка](/n/${targetId})`,
  });

  await page.goto("/graph");

  const folders = page.getByRole("checkbox", { name: "Папки" });
  await expect(folders).toBeChecked();
  await folders.uncheck();

  await page.getByRole("checkbox", { name: /^Без связей/ }).check();

  await page.goto(`/n/${targetId}`);
  await page.goBack();

  await expect(page.getByRole("checkbox", { name: "Папки" })).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /^Без связей/ }),
  ).toBeChecked();

  // И после полной перезагрузки тоже: память в localStorage, а не в истории.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Папки" })).not.toBeChecked();
});

test("фильтр оставляет в списке только совпавшее", async ({ page }) => {
  const targetId = await seedNote({ title: "Дробная сортировка" });
  await createNote(page, {
    title: "Черновик",
    content: `[дробная сортировка](/n/${targetId})`,
  });

  await page.goto("/graph");
  await page.getByText("Те же связи списком").click();

  const list = page.getByRole("list", { name: "Связи заметок" });
  await expect(list.getByRole("listitem")).toHaveCount(2);

  await page.getByRole("searchbox", { name: "Найти заметку на карте" }).fill("чернов");

  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("listitem")).toContainText("Черновик");

  // Промах по всем заголовкам говорит об этом прямо, а не пустотой.
  await page
    .getByRole("searchbox", { name: "Найти заметку на карте" })
    .fill("такого нет");

  await expect(page.getByText("Ничего не нашлось")).toBeVisible();
});

test("слой похожих включается тумблером и добавляет связи", async ({ page }) => {
  // Связи в тексте нет ни одной: всё, что появится на карте, придёт
  // от косинуса. Без ключа к модели тумблера не будет вовсе — тогда
  // проверять нечего, и тест пропускается.
  await seedNote({
    title: "Порядок элементов",
    content: "position numeric(20,10), новая позиция — среднее между соседями",
  });
  await seedNote({
    title: "Ребалансировка веток",
    content: "Когда зазор позиций становится меньше 1e-6, ветка пересчитывается.",
  });

  await page.goto("/graph");

  const toggle = page.getByRole("checkbox", { name: "Похожие по смыслу" });

  if ((await toggle.count()) === 0) {
    test.skip(true, "MWS_API_KEY не задан — смыслового слоя нет");
    return;
  }

  await expect(page.getByText("Показывать нечего")).toBeVisible();

  await toggle.check();

  // Ответ идёт во внешний API за векторами, поэтому ждём появления карты,
  // а не фиксированной паузы.
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toBeVisible({ timeout: 60_000 });

  await page.getByText("Те же связи списком").click();
  await expect(
    page.getByRole("list", { name: "Связи заметок" }).getByRole("listitem"),
  ).toHaveCount(2);
});

test.describe("на узком экране", () => {
  // Телефон: колеса нет, места мало. Проверяем, что карта вообще
  // добирается до экрана и что масштаб можно менять без колеса.
  test.use({ viewport: { width: 390, height: 844 } });

  test("карта и кнопки масштаба помещаются", async ({ page }) => {
    const targetId = await seedNote({ title: "Дробная сортировка" });
    await createNote(page, {
      title: "Черновик",
      content: `[дробная сортировка](/n/${targetId})`,
    });

    await page.goto("/graph");

    const canvas = page.getByRole("img", {
      name: "Карта связей между заметками",
    });
    await expect(canvas).toBeVisible();

    // Холст не должен вылезать за ширину экрана: горизонтальной прокрутки
    // у страницы быть не может.
    const box = await canvas.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);

    for (const name of ["Приблизить", "Отдалить", "Вписать карту целиком"]) {
      await expect(page.getByRole("button", { name })).toBeVisible();
    }

    await page.getByRole("button", { name: "Приблизить" }).click();
    await page.getByRole("button", { name: "Вписать карту целиком" }).click();

    // Тумблеры и фильтр переносятся, а не уезжают за край.
    await expect(page.getByRole("checkbox", { name: "Папки" })).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Найти заметку на карте" }),
    ).toBeVisible();
  });
});

test("на странице заметки карта разворачивается по кнопке", async ({ page }) => {
  const targetId = await seedNote({ title: "Дробная сортировка" });
  const sourceId = await createNote(page, {
    title: "Черновик",
    content: `[дробная сортировка](/n/${targetId})`,
  });

  await page.goto(`/n/${sourceId}`);

  const toggle = page.getByRole("button", { name: "Карта связей" });
  await expect(toggle).toBeVisible();

  // До нажатия холста нет: окрестность считается по всему графу владельца,
  // и платить за неё при каждом открытии редактора незачем.
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toHaveCount(0);

  await toggle.click();

  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Скрыть карту" }).click();
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toHaveCount(0);
});

test("карта заметки показывает похожих, а не только ссылки", async ({
  page,
}) => {
  // Ходит в настоящий MWS за векторами — как и тест похожих в links.spec.ts.
  test.skip(!process.env.MWS_API_KEY, "MWS_API_KEY не задан");

  // Ни одной ссылки в тексте: на прежней карте, знавшей только note_links,
  // у этой заметки было бы «связей нет».
  const sourceId = await seedNote({
    title: "Порядок элементов в дереве",
    content:
      "Позиция хранится как numeric(20,10). Новая позиция — среднее между соседями, при слишком малом зазоре ветка ребалансируется.",
  });

  await seedNote({
    title: "Ребалансировка веток",
    content:
      "Когда зазор позиций становится меньше 1e-6, ветка пересчитывается целиком и позиции раскладываются заново.",
  });

  await page.goto(`/n/${sourceId}`);
  await page.getByRole("button", { name: "Карта связей" }).click();

  // Первый заход считает векторы во внешнем API — дольше обычного запроса.
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText("У этой заметки пока нет связей")).toHaveCount(0);
});

test("у заметки без связей карта честно говорит, что связей нет", async ({
  page,
}) => {
  const noteId = await seedNote({ title: "Сама по себе" });

  await page.goto(`/n/${noteId}`);
  await page.getByRole("button", { name: "Карта связей" }).click();

  await expect(page.getByText("У этой заметки пока нет связей")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Карта связей между заметками" }),
  ).toHaveCount(0);
});

test("заметка в папке связана с ней на карте", async ({ page }) => {
  // Слой папок — ответ на то, что на живой базе ссылок мало: без него
  // карта у большинства была бы облаком несвязанных точек.
  const created = await page.request.post("/api/folders", {
    data: { title: "Рабочее", parentId: null },
  });
  expect(created.ok()).toBeTruthy();
  const folderId = (await created.json()).id as string;

  const moved = await page.request.post(
    `/api/notes/${await createNote(page, { title: "Внутри" })}/move`,
    { data: { targetFolderId: folderId } },
  );
  expect(moved.ok()).toBeTruthy();

  await page.goto("/graph");
  await page.getByText("Те же связи списком").click();

  await expect(
    page
      .getByRole("list", { name: "Связи заметок" })
      .getByRole("listitem")
      .filter({ hasText: "папка «Рабочее»" }),
  ).toContainText("Внутри");
});
