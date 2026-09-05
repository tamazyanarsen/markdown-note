import {
  editorText,
  expect,
  expectSaved,
  resetTestUser,
  seedNote,
  test,
} from "./fixtures";

/**
 * Вставка картинки и права на вложение.
 *
 * Проверяется вся дорога: событие paste в CodeMirror → загрузка → замена
 * плейсхолдера ссылкой → картинка в превью → доступ гостя до и после
 * публикации заметки.
 */

/** Настоящий 1×1 png: превью должно не просто вставить <img>, а показать его. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.beforeEach(resetTestUser);

test("картинка из буфера вставляется, показывается и живёт по правам заметки", async ({
  page,
  browser,
  baseURL,
}) => {
  const noteId = await seedNote({ title: "Заметка с картинкой" });
  await page.goto(`/n/${noteId}`);

  const editor = page.locator(".cm-content");
  await editor.click();

  // Настоящее событие paste с файлом внутри — ровно то, что приходит от
  // Ctrl+V после скриншота. Роботом мышь и системный буфер не подделать.
  await editor.evaluate((element, base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "снимок.png", { type: "image/png" }));

    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, PNG_BASE64);

  // Плейсхолдер сменился настоящей ссылкой.
  await expect
    .poll(() => editorText(page), { timeout: 20_000 })
    .toMatch(/!\[снимок\.png\]\(\/api\/files\/[0-9a-f-]{36}\)/);

  const fileUrl = (await editorText(page)).match(/\/api\/files\/[0-9a-f-]{36}/)![0];
  await expectSaved(page);

  // Превью показывает картинку, а не битую ссылку.
  await page.getByRole("button", { name: "Превью" }).click();
  const image = page.locator(`img[src="${fileUrl}"]`);
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);

  // Гость: у приватной заметки вложение не существует.
  const guest = await browser.newContext();
  try {
    expect((await guest.request.get(`${baseURL}${fileUrl}`)).status()).toBe(404);

    await page.getByRole("button", { name: "Опубликовать" }).click();
    await expect(page.getByRole("button", { name: "Опубликована" })).toBeVisible();

    const published = await guest.request.get(`${baseURL}${fileUrl}`);
    expect(published.status()).toBe(200);
    expect(published.headers()["content-type"]).toBe("image/png");

    await page.getByRole("button", { name: "Опубликована" }).click();
    await expect(page.getByRole("button", { name: "Опубликовать" })).toBeVisible();

    expect((await guest.request.get(`${baseURL}${fileUrl}`)).status()).toBe(404);
  } finally {
    await guest.close();
  }
});

test("файл запрещённого типа не загружается и текст не портит", async ({ page }) => {
  const noteId = await seedNote({ title: "Заметка", content: "Начало." });
  await page.goto(`/n/${noteId}`);

  const editor = page.locator(".cm-content");
  await editor.click();

  await editor.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["<svg/>"], "картинка.svg", { type: "image/svg+xml" }));

    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // Причина отказа видна дословно, а не общим «некорректные данные»:
  // человек должен понять, что именно не так с файлом.
  await expect(page.getByText(/загружать нельзя.*svg/i)).toBeVisible();
  await expect.poll(() => editorText(page)).not.toContain("загружаю");
  await expect.poll(() => editorText(page)).toContain("Начало.");
});
