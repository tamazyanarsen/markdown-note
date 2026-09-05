import type { FullConfig } from "@playwright/test";

/**
 * Прогрев dev-сервера перед прогоном.
 *
 * `next dev` компилирует страницу и маршрут при первом обращении к ним,
 * и первый заход стоит секунд. Тест, который в это время печатает в редакторе
 * и ждёт выпадающий список, гоняется с компилятором и проигрывает примерно
 * раз из десяти — причём всегда первый по счёту, то есть падает то один тест,
 * то другой, в зависимости от порядка.
 *
 * Лечится не таймаутами в тестах, а тем, чтобы к их старту всё уже было
 * собрано. Ответы здесь не важны: гость получит 401 и 404, но маршрут
 * скомпилируется именно на этом запросе.
 */

/** Пути, которые трогают тесты. Ответ не важен, важен сам факт обращения. */
const ROUTES = [
  "/",
  "/signin",
  "/n/00000000-0000-4000-8000-000000000000",
  "/api/search?q=прогрев&mode=fts",
  "/api/search?q=прогрев&mode=hybrid",
  "/api/notes/00000000-0000-4000-8000-000000000000/connections",
  "/api/files/00000000-0000-4000-8000-000000000000",
];

async function warmUp(baseURL: string, path: string): Promise<void> {
  try {
    await fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(60_000) });
  } catch {
    // Прогрев — это оптимизация, а не проверка. Недоступный маршрут
    // покажет себя в самом тесте, и там сообщение будет понятнее.
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:3000";

  // Последовательно, а не параллельно: одновременная компиляция семи
  // маршрутов в dev упирается в одно ядро и выходит не быстрее.
  for (const path of ROUTES) {
    await warmUp(baseURL, path);
  }

  // POST-маршруты отдельно: GET по ним отдал бы 405, не тронув обработчик.
  await fetch(`${baseURL}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: "прогрев" }),
    signal: AbortSignal.timeout(60_000),
  }).catch(() => {});
}
