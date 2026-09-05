import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { EMBEDDING_DIMENSIONS, users } from "@/db/schema";
import { archiveNote, createNote } from "@/domain/notes";
import { getRelatedNotes, type Embedder } from "@/domain/search";

/**
 * Похожие заметки.
 *
 * Тот же векторный слой, что и у поиска, но запросом служит не текст человека,
 * а сама заметка. Проверяем изоляцию владельцев, исключение самой заметки
 * и архивных, отсечку по расстоянию и поведение без векторизатора.
 *
 * Нужен настоящий Postgres с расширением vector — `npm run db:up`.
 */

const HANNA = "a8888888-8888-4888-8888-888888888888";
const IVAN = "a9999999-9999-4999-8999-999999999999";

/** Темы подставного векторизатора — тот же приём, что в tests/search.test.ts. */
const TOPICS = [
  ["дробн", "numeric", "между соседями", "позици"],
  ["авторизац", "oauth", "провайдер входа"],
];

function stubVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const lower = text.toLowerCase();

  TOPICS.forEach((words, index) => {
    if (words.some((word) => lower.includes(word))) vector[index] = 1;
  });

  // Нулевой вектор недопустим: косинусное расстояние от него не определено.
  vector[EMBEDDING_DIMENSIONS - 1] = 0.01;

  return vector;
}

const embed: Embedder = async (texts) => texts.map(stubVector);

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [HANNA, IVAN]));
  await db.insert(users).values([
    { id: HANNA, email: "hanna-related@example.com", isApproved: true },
    { id: IVAN, email: "ivan-related@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [HANNA, IVAN]));
  await pool.end();
});

describe("похожие заметки", () => {
  it("находит заметку об одном и том же, хотя слова разные", async () => {
    const source = await createNote(HANNA, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });

    const sibling = await createNote(HANNA, {
      title: "Ребалансировка",
      folderId: null,
      content: "Когда зазор позиций становится меньше 1e-6.",
    });

    const result = await getRelatedNotes(HANNA, source.id, { embed });

    expect(result.semantic).toBe(true);
    expect(result.hits.map((hit) => hit.id)).toEqual([sibling.id]);
  });

  it("не показывает саму заметку", async () => {
    const source = await createNote(HANNA, {
      title: "Дробные позиции",
      folderId: null,
      content: "position numeric(20,10)",
    });

    const result = await getRelatedNotes(HANNA, source.id, { embed });

    expect(result.hits.map((hit) => hit.id)).not.toContain(source.id);
  });

  it("не показывает чужие заметки, даже слово в слово те же", async () => {
    const source = await createNote(HANNA, {
      title: "Дробные позиции",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });

    await createNote(IVAN, {
      title: "Дробные позиции",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });

    // Чужая заметка индексируется своим владельцем — иначе её векторов
    // просто не было бы в базе и проверка ничего не значила бы.
    const foreign = await createNote(IVAN, { title: "Ещё", folderId: null });
    await getRelatedNotes(IVAN, foreign.id, { embed });

    const result = await getRelatedNotes(HANNA, source.id, { embed });

    expect(result.hits).toHaveLength(0);
  });

  it("не показывает архивные", async () => {
    const source = await createNote(HANNA, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10)",
    });

    const sibling = await createNote(HANNA, {
      title: "Ребалансировка",
      folderId: null,
      content: "зазор позиций меньше 1e-6",
    });

    expect((await getRelatedNotes(HANNA, source.id, { embed })).hits).toHaveLength(1);

    await archiveNote(HANNA, sibling.id);

    expect((await getRelatedNotes(HANNA, source.id, { embed })).hits).toHaveLength(0);
  });

  it("не тащит в похожие заметку не о том", async () => {
    // Отсечка MAX_RELATED_DISTANCE: ближайший сосед находится всегда,
    // и без порога сюда попала бы вся база подряд.
    const source = await createNote(HANNA, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10)",
    });

    await createNote(HANNA, {
      title: "Вход через провайдера",
      folderId: null,
      content: "oauth и авторизация",
    });

    const result = await getRelatedNotes(HANNA, source.id, { embed });

    expect(result.hits).toHaveLength(0);
  });

  it("без векторизатора список пуст, а не сломан", async () => {
    // Пустой MWS_API_KEY — штатный режим: поиск остаётся полнотекстовым,
    // а похожих просто нет. Мерить похожесть по словам было бы обманом.
    const saved = process.env.MWS_API_KEY;
    process.env.MWS_API_KEY = "";

    try {
      const source = await createNote(HANNA, {
        title: "Заметка",
        folderId: null,
        content: "текст",
      });

      const result = await getRelatedNotes(HANNA, source.id);

      expect(result).toEqual({ hits: [], semantic: false });
    } finally {
      if (saved === undefined) delete process.env.MWS_API_KEY;
      else process.env.MWS_API_KEY = saved;
    }
  });
});
