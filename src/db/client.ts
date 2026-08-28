import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

// Во время next build подключения к базе нет и быть не должно: сборка
// в Docker идёт без .env. Падать надо в рантайме, когда переменная
// действительно нужна, а не на этапе импорта модуля при сборке.
if (
  !process.env.DATABASE_URL &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  throw new Error("DATABASE_URL не задан. Скопируй .env.example в .env.");
}

// В dev Next.js перезагружает модули на каждое изменение файла.
// Без кеша на globalThis каждая перезагрузка открывала бы новый пул
// и база быстро упиралась бы в max_connections.
const globalForDb = globalThis as unknown as { pool?: Pool };

const pool =
  globalForDb.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    // Сервис не highload: небольшой пул на один инстанс.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
}

export const db = drizzle(pool, {
  schema,
  // Обязано совпадать с drizzle.config.ts.
  casing: "snake_case",
});

export type Database = typeof db;

/** Пул для мест, где нужен «сырой» клиент: транзакции с FOR UPDATE, тесты. */
export { pool };
