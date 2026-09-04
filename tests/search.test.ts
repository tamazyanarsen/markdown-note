import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { EMBEDDING_DIMENSIONS, noteChunks, users } from "@/db/schema";
import { archiveNote, createNote, updateNote } from "@/domain/notes";
import { searchNotes, type Embedder } from "@/domain/search";

/**
 * Гибридный поиск по заметкам.
 *
 * Проверяем то, что нельзя проверить юнит-тестом: изоляцию владельцев на
 * уровне SQL, устаревание векторов по хешу и деградацию до полнотекстового
 * режима, когда внешний API отказал.
 *
 * Нужен настоящий Postgres с расширением vector — `npm run db:up`.
 */

const DANA = "dddddddd-4444-4444-8444-dddddddddddd";
const ERIC = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";

/**
 * Темы для подставного векторизатора.
 *
 * Внутри одной темы слова намеренно разные: так текст заметки и текст запроса
 * оказываются рядом в векторном пространстве, не имея ни одной общей леммы.
 * Ровно этот случай отличает смысловой поиск от полнотекстового.
 */
const TOPICS = [
  ["дробн", "numeric", "между соседями"],
  ["авторизац", "oauth", "провайдер входа"],
];

/**
 * Текст → вектор. Настоящая модель заменена детерминированной функцией:
 * тест не должен ходить в сеть и платить за вызовы.
 */
function stubVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const lower = text.toLowerCase();

  TOPICS.forEach((words, index) => {
    if (words.some((word) => lower.includes(word))) vector[index] = 1;
  });

  // Нулевой вектор недопустим: косинусное расстояние от него не определено,
  // и pgvector вернул бы NaN вместо порядка.
  vector[EMBEDDING_DIMENSIONS - 1] = 0.01;

  return vector;
}

/** Векторизатор со счётчиком — им проверяем, что лишнего не пересчитываем. */
function countingEmbedder() {
  const state = { calls: 0, texts: 0 };

  const embed: Embedder = async (texts) => {
    state.calls += 1;
    state.texts += texts.length;
    return texts.map(stubVector);
  };

  return { embed, state };
}

const failingEmbedder: Embedder = async () => {
  throw new Error("MWS недоступен");
};

async function search(ownerId: string, query: string, embed: Embedder) {
  return searchNotes(ownerId, query, { mode: "hybrid", embed });
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [DANA, ERIC]));
  await db.insert(users).values([
    { id: DANA, email: "dana-search@example.com", isApproved: true },
    { id: ERIC, email: "eric-search@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [DANA, ERIC]));
  await pool.end();
});

describe("гибридный поиск", () => {
  it("находит заметку по смыслу, когда общих слов с запросом нет", async () => {
    const { embed } = countingEmbedder();

    const note = await createNote(DANA, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), новое значение — среднее между соседями.",
    });

    // Полнотекстовый поиск здесь бессилен: ни «дробной», ни «сортировки»
    // в заметке нет.
    const lexical = await searchNotes(DANA, "дробная сортировка", {
      mode: "fts",
    });
    expect(lexical.hits).toHaveLength(0);

    const hybrid = await search(DANA, "дробная сортировка", embed);

    expect(hybrid.semantic).toBe(true);
    expect(hybrid.hits.map((hit) => hit.id)).toContain(note.id);
  });

  it("не показывает чужие заметки даже при точном совпадении", async () => {
    const { embed } = countingEmbedder();

    await createNote(ERIC, {
      title: "Чужая заметка",
      folderId: null,
      content: "дробная сортировка позиций",
    });

    const result = await search(DANA, "дробная сортировка", embed);

    expect(result.hits).toHaveLength(0);
  });

  it("не находит архивные заметки", async () => {
    const { embed } = countingEmbedder();

    const note = await createNote(DANA, {
      title: "Архив",
      folderId: null,
      content: "дробная сортировка позиций",
    });

    expect((await search(DANA, "дробная сортировка", embed)).hits).toHaveLength(1);

    await archiveNote(DANA, note.id);

    expect((await search(DANA, "дробная сортировка", embed)).hits).toHaveLength(0);
  });

  it("переиндексирует заметку после правки и не трогает нетронутые", async () => {
    const { embed, state } = countingEmbedder();

    const note = await createNote(DANA, {
      title: "Заметка",
      folderId: null,
      content: "первый текст",
    });

    await search(DANA, "первый", embed);

    const [chunkBefore] = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    expect(chunkBefore.text).toContain("первый текст");

    // Повторный поиск без правок не должен стоить ни одного лишнего текста
    // в запросе к модели — только векторизации самого запроса.
    const textsAfterFirstSearch = state.texts;
    await search(DANA, "первый", embed);
    expect(state.texts).toBe(textsAfterFirstSearch + 1);

    await updateNote(DANA, note.id, { content: "второй текст" });
    await search(DANA, "второй", embed);

    const [chunkAfter] = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    expect(chunkAfter.text).toContain("второй текст");
    expect(chunkAfter.sourceHash).not.toBe(chunkBefore.sourceHash);
  });

  it("правка одного заголовка тоже помечает векторы устаревшими", async () => {
    // Хеш считается от title || content: заголовок уходит в модель вместе
    // с текстом, значит его правка меняет и вектор.
    const { embed } = countingEmbedder();

    const note = await createNote(DANA, {
      title: "Старое название",
      folderId: null,
      content: "текст",
    });

    await search(DANA, "текст", embed);
    const [before] = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    await updateNote(DANA, note.id, { title: "Новое название" });
    await search(DANA, "текст", embed);

    const [after] = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it("заметка без текста индексируется один раз, а не на каждый поиск", async () => {
    // Пустой content даёт один пустой кусок. Ноль кусков означал бы
    // «не проиндексирована», и заметка жгла бы вызовы API вечно.
    const { embed, state } = countingEmbedder();

    await createNote(DANA, { title: "Пустая", folderId: null });

    await search(DANA, "пустая", embed);
    const afterFirst = state.texts;

    await search(DANA, "пустая", embed);

    expect(state.texts).toBe(afterFirst + 1);
  });

  it("не вываливает всю базу на посторонний запрос", async () => {
    // Векторный поиск сам по себе всегда отдаёт N ближайших соседей, каким бы
    // далёким ни был ближайший. Без отсечки по расстоянию запрос не по теме
    // возвращал бы все заметки подряд — см. MAX_SEMANTIC_DISTANCE.
    const { embed } = countingEmbedder();

    await createNote(DANA, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });

    // Запрос не попадает ни в одну тему подставного векторизатора,
    // то есть лежит далеко от всего, что есть в базе.
    const result = await search(DANA, "рецепт борща со сметаной", embed);

    expect(result.semantic).toBe(true);
    expect(result.hits).toHaveLength(0);
  });

  it("при отказе внешнего API отдаёт полнотекстовую выдачу, а не ошибку", async () => {
    const note = await createNote(DANA, {
      title: "Заметка про Docker",
      folderId: null,
      content: "Собираем образ и поднимаем контейнер.",
    });

    const result = await search(DANA, "контейнер", failingEmbedder);

    expect(result.semantic).toBe(false);
    expect(result.hits.map((hit) => hit.id)).toEqual([note.id]);
  });

  it("короткий и пустой запрос ничего не ищут", async () => {
    const { embed, state } = countingEmbedder();

    await createNote(DANA, {
      title: "Заметка",
      folderId: null,
      content: "какой-то текст",
    });

    expect((await search(DANA, "   ", embed)).hits).toHaveLength(0);
    expect(state.calls).toBe(0);
  });
});
