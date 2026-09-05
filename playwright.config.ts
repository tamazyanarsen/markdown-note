import { defineConfig, devices } from "@playwright/test";

/**
 * Локальный адрес мимо прокси.
 *
 * Если в окружении задан HTTP_PROXY (корпоративная сеть, контейнер сборки),
 * через него уйдёт и запрос к localhost — и Playwright не дождётся своего же
 * dev-сервера, потому что прокси до него не достучится. Правится не в тесте,
 * а здесь: и проверка готовности сервера, и сам браузер должны ходить
 * на 3000 напрямую.
 */
const NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1"]
  .filter(Boolean)
  .join(",");

process.env.NO_PROXY = NO_PROXY;
process.env.no_proxy = NO_PROXY;

/**
 * Браузерные тесты.
 *
 * Отдельно от vitest намеренно: там доменный слой против настоящего
 * Postgres, здесь — то, до чего доменный слой не достаёт. Автодополнение
 * по `[[`, вставка картинки из буфера, панель связей и режим ответа
 * в палитре живут целиком в браузере, и проверить их можно только браузером.
 *
 * Запуск: `npm run e2e` (нужен `npm run db:up`).
 */
export default defineConfig({
  testDir: "./e2e",

  // Тесты ходят в ту же базу, что и dev-сервер, и создают там заметки.
  // Параллельные воркеры мешали бы друг другу — так же, как в vitest.
  fullyParallel: false,
  workers: 1,

  // Dev-сервер компилирует страницу на первый заход, а вопрос к заметкам
  // ждёт ответа внешней модели. Обычных 30 секунд на это не хватает.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: [["list"]],

  // Компиляция маршрутов в dev стоит секунд, и первый по счёту тест
  // гонялся с ней. Прогреваем до старта — см. комментарий в файле.
  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chrome",
      // channel вместо скачанного chromium: настоящий Chrome на машине уже
      // есть, а playwright install тянет ещё полторы сотни мегабайт.
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        // Chrome берёт прокси из системных настроек, а не из NO_PROXY,
        // поэтому исключение для localhost ему нужно отдельным флагом.
        launchOptions: { args: ["--proxy-bypass-list=<-loopback>"] },
      },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/signin",
    // Поднятый вручную dev-сервер переиспользуем: перезапуск на каждый
    // прогон стоил бы минуты холодной компиляции.
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
