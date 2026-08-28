import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // В TypeScript пишем camelCase, в базе получаем snake_case.
  // То же значение обязано стоять в src/db/client.ts, иначе
  // сгенерированные миграции разойдутся с рантайм-запросами.
  casing: "snake_case",
});
