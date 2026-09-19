import { expect, resetTestUser, seedNote, test } from "./fixtures";

/**
 * Content-Security-Policy.
 *
 * Проверяется одно, но важное: под настоящей политикой приложение живо.
 * Доказательство не в отсутствии ошибок в консоли, а в том, что работает
 * то, что без выполненного js работать не может — редактор CodeMirror,
 * модальный диалог, палитра по Ctrl+K. Если бы скрипты блокировались,
 * ни один из этих узлов не появился бы.
 *
 * Плюс сами нарушения: любой инлайн-скрипт, добавленный когда-нибудь
 * в разметку без nonce, всплывёт здесь, а не на проде.
 */

test.beforeEach(resetTestUser);

/** Всё, на что браузер пожаловался как на нарушение политики. */
function collectViolations(page: import("@playwright/test").Page): string[] {
  const violations: string[] = [];

  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  return violations;
}

test("под политикой работает то, для чего нужен js", async ({ page }) => {
  const noteId = await seedNote({
    title: "Заметка под CSP",
    content: "# Заголовок\n\nТекст.",
  });

  const violations = collectViolations(page);

  // Заголовок вообще есть, и в нём есть nonce.
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src [^;]*'nonce-[^']+'/);
  expect(csp).toContain("'strict-dynamic'");

  // Редактор — клиентский компонент: без выполненного js его не будет.
  await page.goto(`/n/${noteId}`);
  await expect(page.locator(".cm-content")).toBeVisible();

  // Диалог: Radix вставляет <style> в рантайме, и это самое узкое место
  // политики — из-за него style-src пришлось оставить с 'unsafe-inline'.
  await page.goto("/");
  await page.getByRole("button", { name: "Заметка", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  // Палитра: перехват сочетания клавиш и cmdk.
  await page.keyboard.press("Control+k");
  await expect(page.getByPlaceholder(/Найти заметку/i)).toBeVisible();
  await page.keyboard.press("Escape");

  expect(violations, `нарушения CSP:\n${violations.join("\n")}`).toHaveLength(0);
});

test("у страницы заметки для гостя тоже есть политика", async ({
  page,
  browser,
  baseURL,
}) => {
  const noteId = await seedNote({ title: "Публичная", content: "Текст." });

  // Публикуем от владельца: у page сессия уже есть, её кладёт fixtures.ts.
  const published = await page.request.post(`/api/notes/${noteId}/publish`);
  expect(published.ok()).toBeTruthy();

  // Гость — отдельный контекст, без cookie сессии. Публичная страница и есть
  // главное место, ради которого политика заводилась: там показывается
  // markdown, написанный человеком.
  const guest = await browser.newContext({ baseURL });
  const guestPage = await guest.newPage();
  const violations = collectViolations(guestPage);

  const response = await guestPage.goto(`/n/${noteId}`);
  expect(response?.headers()["content-security-policy"]).toContain("'strict-dynamic'");
  await expect(guestPage.getByRole("heading", { name: "Публичная" })).toBeVisible();

  expect(violations, `нарушения CSP:\n${violations.join("\n")}`).toHaveLength(0);
  await guest.close();
});
