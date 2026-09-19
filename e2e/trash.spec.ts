import { expect, resetTestUser, seedNote, test } from "./fixtures";

/**
 * Корзина.
 *
 * Доменные тесты проверяют, что и куда уезжает; здесь проверяется только то,
 * до чего они не достают: что человек вообще может вернуть удалённое, не зная
 * про существование страницы /trash, и что «удалить навсегда» действительно
 * спрашивает подтверждение.
 */

test.beforeEach(resetTestUser);

/** Открывает меню строки дерева и жмёт «Удалить». */
async function deleteFromTree(
  page: import("@playwright/test").Page,
  title: string,
): Promise<void> {
  const row = page.getByRole("link", { name: title });
  await expect(row).toBeVisible();
  await row.hover();

  await page.getByRole("button", { name: `Действия: ${title}` }).click();
  await page.getByRole("menuitem", { name: "Удалить" }).click();
  await page.getByRole("button", { name: "В корзину" }).click();
}

test("тост после удаления возвращает заметку в дерево", async ({ page }) => {
  await seedNote({ title: "Черновик" });

  await page.goto("/");
  await deleteFromTree(page, "Черновик");

  await expect(page.getByRole("link", { name: "Черновик" })).toHaveCount(0);

  // Тост — единственный путь назад для того, кто про корзину ещё не знает.
  await page.getByRole("button", { name: "Восстановить" }).click();

  await expect(page.getByRole("link", { name: "Черновик" })).toBeVisible();
});

test("удалённая заметка лежит в корзине и уходит оттуда насовсем", async ({
  page,
}) => {
  await seedNote({ title: "Черновик" });

  await page.goto("/");
  await deleteFromTree(page, "Черновик");

  await page.getByRole("link", { name: "Корзина" }).click();
  await expect(page).toHaveURL(/\/trash$/);

  const row = page.getByRole("listitem").filter({ hasText: "Черновик" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Удалить навсегда «Черновик»" }).click();

  // Необратимое действие обязано спрашивать: кнопка в списке только открывает
  // диалог, удаляет подтверждение в нём.
  await expect(
    page.getByRole("alertdialog").getByText("Отменить это будет нельзя", {
      exact: false,
    }),
  ).toBeVisible();

  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Удалить навсегда" })
    .click();

  await expect(page.getByText("Здесь пусто", { exact: false })).toBeVisible();
});

test("корзина читается на узком экране", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await seedNote({ title: "Заметка для телефона" });

  await page.goto("/");

  // На телефоне дерево живёт в выезжающей панели.
  await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  await deleteFromTree(page, "Заметка для телефона");

  await page.goto("/trash");

  const row = page.getByRole("listitem").filter({ hasText: "Заметка для телефона" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Восстановить" })).toBeVisible();

  // Полоса не должна разъезжаться шире экрана: заголовок обрезается,
  // кнопки переносятся.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
