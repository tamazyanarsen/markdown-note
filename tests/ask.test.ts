import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { EMBEDDING_DIMENSIONS, users } from "@/db/schema";
import { askNotes, type Completer } from "@/domain/ask";
import { createNote } from "@/domain/notes";
import type { Embedder } from "@/domain/search";
import type { ChatMessage } from "@/lib/chat";

/**
 * Вопрос к своим заметкам.
 *
 * Retrieval здесь тот же, что у поиска, и отдельно не перепроверяется.
 * Проверяем то, что добавилось: в промпт уходит текст найденных заметок,
 * а отказ генерации не превращается в ошибку — источники остаются.
 *
 * Ни векторизатор, ни модель в сеть не ходят: оба подставные.
 *
 * Нужен настоящий Postgres с расширением vector — `npm run db:up`.
 */

const LARA = "aaaaaaaa-1212-4012-8012-aaaaaaaaaaaa";
const MARK = "bbbbbbbb-1313-4013-8013-bbbbbbbbbbbb";

const TOPICS = [
  ["доступ", "видеть", "право", "владелец"],
  ["docker", "контейнер", "образ"],
];

function stubVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const lower = text.toLowerCase();

  TOPICS.forEach((words, index) => {
    if (words.some((word) => lower.includes(word))) vector[index] = 1;
  });

  vector[EMBEDDING_DIMENSIONS - 1] = 0.01;
  return vector;
}

const embed: Embedder = async (texts) => texts.map(stubVector);

/** Подставная модель со счётчиком и запомненным промптом. */
function recordingCompleter(answer = "Короткий ответ [1].") {
  const state = { calls: 0, messages: [] as ChatMessage[] };

  const complete: Completer = async (messages) => {
    state.calls += 1;
    state.messages = messages;
    return answer;
  };

  return { complete, state };
}

const failingCompleter: Completer = async () => {
  throw new Error("Модель недоступна");
};

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [LARA, MARK]));
  await db.insert(users).values([
    { id: LARA, email: "lara-ask@example.com", isApproved: true },
    { id: MARK, email: "mark-ask@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [LARA, MARK]));
  await pool.end();
});

describe("вопрос к заметкам", () => {
  it("отвечает и показывает, на чём построен ответ", async () => {
    const { complete, state } = recordingCompleter();

    const note = await createNote(LARA, {
      title: "ADR: доступы",
      folderId: null,
      content: "Владелец видит всё своё дерево, гость — только public-заметки.",
    });

    const result = await askNotes(LARA, "кто имеет право видеть записи", {
      embed,
      complete,
    });

    expect(result.answer).toBe("Короткий ответ [1].");
    expect(result.sources.map((hit) => hit.id)).toEqual([note.id]);

    // В промпт уходит текст заметки, а не сниппет из выдачи: на сниппете
    // в 200 символов отвечать было бы не на чем.
    const prompt = state.messages.at(-1)?.content ?? "";
    expect(prompt).toContain("[1] ADR: доступы");
    expect(prompt).toContain("гость");
    expect(prompt).toContain("кто имеет право видеть записи");
  });

  it("нумерация источников совпадает с порядком в промпте", async () => {
    const { complete, state } = recordingCompleter();

    await createNote(LARA, {
      title: "Права доступа",
      folderId: null,
      content: "Владелец видит своё дерево целиком.",
    });

    await createNote(LARA, {
      title: "Гостевой доступ",
      folderId: null,
      content: "Гость видит только public-заметки и путь к ним.",
    });

    const result = await askNotes(LARA, "право видеть заметки", {
      embed,
      complete,
    });

    const prompt = state.messages.at(-1)?.content ?? "";

    result.sources.forEach((hit, index) => {
      expect(prompt).toContain(`[${index + 1}] ${hit.title}`);
    });
  });

  it("при отказе модели отдаёт источники, а не ошибку", async () => {
    const note = await createNote(LARA, {
      title: "ADR: доступы",
      folderId: null,
      content: "Владелец видит всё своё дерево.",
    });

    const result = await askNotes(LARA, "кто имеет право видеть записи", {
      embed,
      complete: failingCompleter,
    });

    expect(result.answer).toBeNull();
    expect(result.sources.map((hit) => hit.id)).toEqual([note.id]);
  });

  it("без настроенной модели ищет, но не пересказывает", async () => {
    // Незаполненный MWS_CHAT_MODEL — штатный режим, а не поломка:
    // тот же принцип, что у поиска без ключа.
    const saved = process.env.MWS_CHAT_MODEL;
    delete process.env.MWS_CHAT_MODEL;

    try {
      const note = await createNote(LARA, {
        title: "ADR: доступы",
        folderId: null,
        content: "Владелец видит всё своё дерево.",
      });

      const result = await askNotes(LARA, "кто имеет право видеть записи", {
        embed,
      });

      expect(result.answer).toBeNull();
      expect(result.sources.map((hit) => hit.id)).toEqual([note.id]);
    } finally {
      if (saved !== undefined) process.env.MWS_CHAT_MODEL = saved;
    }
  });

  it("не тратит вызов модели, когда искать не по чему", async () => {
    const { complete, state } = recordingCompleter();

    await createNote(LARA, {
      title: "Заметка про Docker",
      folderId: null,
      content: "Собираем образ и поднимаем контейнер.",
    });

    const result = await askNotes(LARA, "рецепт борща со сметаной", {
      embed,
      complete,
    });

    expect(result.sources).toHaveLength(0);
    expect(result.answer).toBeNull();
    expect(state.calls).toBe(0);
  });

  it("не отвечает по чужим заметкам", async () => {
    const { complete } = recordingCompleter();

    await createNote(MARK, {
      title: "Чужая про доступы",
      folderId: null,
      content: "Владелец видит всё своё дерево.",
    });

    const result = await askNotes(LARA, "кто имеет право видеть записи", {
      embed,
      complete,
    });

    expect(result.sources).toHaveLength(0);
  });
});
