import { eq, inArray } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { replaceNoteChunks } from "@/db/queries/search";
import { EMBEDDING_DIMENSIONS, noteChunks, users } from "@/db/schema";
import { archiveNote, createNote, updateNote } from "@/domain/notes";
import { searchNotes, type Embedder } from "@/domain/search";

/**
 * Одновременная переиндексация.
 *
 * Индексацию запускают два разных места — поиск и панель связей под
 * редактором, — и запросто вместе: панель дёргается на каждое открытие
 * заметки, поиск на каждый запрос. Обе гонки ниже наблюдались в логах
 * живого dev-сервера, обе закрыты блокировкой строки заметки
 * в replaceNoteChunks.
 *
 * Тесты написаны после починки, поэтому проверено главное — что они ловят
 * именно регрессию, а не просто зеленеют. С убранной строкой `.for("update")`
 * первые три падают, все три прогона подряд. Четвёртый про соседний
 * сценарий и проходит в обоих случаях, о чём сказано на месте.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const NINA = "aaaaaaaa-1414-4014-8014-aaaaaaaaaaaa";

/**
 * Медленный векторизатор.
 *
 * Задержка не украшение: без неё второй вызов успевает записать векторы
 * раньше, чем первый дойдёт до своей записи, окна для гонки не возникает,
 * и тест зеленел бы независимо от блокировки.
 */
function slowEmbedder(delayMs = 60): Embedder {
  return async (texts) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    return texts.map(() => {
      const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      vector[0] = 1;
      return vector;
    });
  };
}

function vectorOf(value: number): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = value;
  return vector;
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [NINA]));
  await db
    .insert(users)
    .values({ id: NINA, email: "nina-race@example.com", isApproved: true });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [NINA]));
  await pool.end();
});

describe("гонки переиндексации", () => {
  it("запись векторов ждёт занятую заметку, а не лезет параллельно", async () => {
    // Прямая проверка механизма, которым закрыты обе гонки.
    //
    // Просто запустить две записи разом мало: delete с insert укладываются
    // в доли миллисекунды, транзакции не пересекаются, и тест зеленел бы
    // даже без блокировки — проверено, именно так он и вёл себя сначала.
    // Поэтому строку заметки держит посторонний клиент, а мы смотрим,
    // остановится ли перед ней replaceNoteChunks.
    //
    // Держим её именно FOR KEY SHARE, а не FOR UPDATE, и это тонкость,
    // без которой проверка бессмысленна. Вставка в note_chunks и сама берёт
    // на родительской строке FOR KEY SHARE — так Postgres не даёт удалить
    // заметку из-под внешнего ключа. С FOR UPDATE у постороннего клиента
    // ждала бы любая вставка, и тест проходил бы независимо от нашей
    // блокировки. FOR KEY SHARE со вставкой совместим и конфликтует ровно
    // с FOR UPDATE — тем самым, который берём мы.
    const note = await createNote(NINA, {
      title: "Занятая",
      folderId: null,
      content: "текст",
    });

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();

    let finished = false;
    let pending: Promise<void> | null = null;

    try {
      // Страховка от самого себя: если тест свалится посреди транзакции,
      // Postgres сам прибьёт эту сессию и снимет блокировку. Иначе она
      // пережила бы прогон и подвесила следующий — на чужом файле,
      // где искать её никто не станет.
      await blocker.query("set idle_in_transaction_session_timeout = '5s'");

      await blocker.query("begin");
      await blocker.query("select id from notes where id = $1 for key share", [
        note.id,
      ]);

      pending = replaceNoteChunks(note.id, "hash", [
        { text: "текст", embedding: vectorOf(1) },
      ]).then(() => {
        finished = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Без .for("update") запись не заметила бы чужой блокировки: она идёт
      // по note_chunks, а занята строка в notes. Здесь она обязана ждать.
      expect(finished).toBe(false);
    } finally {
      // Снимаем блокировку и обязательно дожидаемся запись — иначе при
      // упавшей проверке она осталась бы висеть в фоне, а afterAll закрыл бы
      // пул у неё под ногами.
      await blocker.query("rollback").catch(() => {});
      await blocker.end();
      await pending?.catch(() => {});
    }

    expect(finished).toBe(true);

    const stored = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    expect(stored).toHaveLength(1);
  });

  it("не пишет векторы заметки, которой уже нет", async () => {
    // Настоящий сценарий: векторы считаются секундами во внешнем API,
    // и за это время заметку успели удалить. Insert упал бы по внешнему
    // ключу — а делать тут нечего, это не ошибка.
    const note = await createNote(NINA, {
      title: "Исчезнет",
      folderId: null,
      content: "текст",
    });

    await db.delete(users).where(eq(users.id, NINA));

    await expect(
      replaceNoteChunks(note.id, "hash", [
        { text: "текст", embedding: vectorOf(1) },
      ]),
    ).resolves.toBeUndefined();

    const stored = await db
      .select()
      .from(noteChunks)
      .where(eq(noteChunks.noteId, note.id));

    expect(stored).toHaveLength(0);
  });

  it("параллельные поиски по устаревшим векторам все остаются смысловыми", async () => {
    // Симптом, с которого всё началось: панель связей и поиск дёргаются
    // одновременно, и один из них падал на индексации. Наружу это выходило
    // не ошибкой, а молчаливой деградацией — searchNotes ловит исключение
    // и отдаёт полнотекстовую выдачу. Поэтому проверяем semantic, а не throw.
    const notes = await Promise.all([
      createNote(NINA, { title: "Первая", folderId: null, content: "текст один" }),
      createNote(NINA, { title: "Вторая", folderId: null, content: "текст два" }),
      createNote(NINA, { title: "Третья", folderId: null, content: "текст три" }),
    ]);

    const embed = slowEmbedder();

    // Первый проход индексирует всё.
    await searchNotes(NINA, "текст", { mode: "hybrid", embed });

    // Правим все три — теперь векторы всех трёх устарели, и каждый
    // из параллельных запросов возьмётся их догонять.
    await Promise.all(
      notes.map((note) =>
        updateNote(NINA, note.id, { content: `${note.title} обновлённый текст` }),
      ),
    );

    const results = await Promise.all([
      searchNotes(NINA, "обновлённый", { mode: "hybrid", embed }),
      searchNotes(NINA, "обновлённый", { mode: "hybrid", embed }),
      searchNotes(NINA, "обновлённый", { mode: "hybrid", embed }),
    ]);

    // Ни один не свалился в полнотекстовый режим.
    expect(results.map((result) => result.semantic)).toEqual([true, true, true]);

    // И векторы в базе консистентны: по два куска на заметку не появилось,
    // осиротевших строк от проигравшей транзакции не осталось.
    for (const note of notes) {
      const stored = await db
        .select()
        .from(noteChunks)
        .where(eq(noteChunks.noteId, note.id));

      expect(stored).toHaveLength(1);
      expect(new Set(stored.map((chunk) => chunk.sourceHash)).size).toBe(1);
    }
  });

  it("архивация во время индексации ничего не ломает", async () => {
    // Оговорка: в отличие от трёх тестов выше, этот проходит и с убранной
    // блокировкой. Регрессию по ней он не сторожит и здесь не за этим —
    // он закрывает соседний сценарий: заметку архивируют ровно в тот момент,
    // когда её индексируют. Архивация идёт мимо note_chunks, и заметка
    // просто выпадает из findStaleNotes; проверяем, что наружу это выходит
    // без ошибки, а не 500-м.
    const note = await createNote(NINA, {
      title: "Уедет в архив",
      folderId: null,
      content: "текст про архив",
    });

    await createNote(NINA, {
      title: "Останется",
      folderId: null,
      content: "текст про остаток",
    });

    const embed = slowEmbedder();

    const [first] = await Promise.all([
      searchNotes(NINA, "текст", { mode: "hybrid", embed }),
      archiveNote(NINA, note.id),
    ]);

    expect(first.semantic).toBe(true);

    const after = await searchNotes(NINA, "текст", { mode: "hybrid", embed });

    expect(after.semantic).toBe(true);
    expect(after.hits.map((hit) => hit.id)).not.toContain(note.id);
  });
});
