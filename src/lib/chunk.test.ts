import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CHUNK_MAX_CHARS, embeddingInput, splitIntoChunks } from "./chunk";

describe("splitIntoChunks", () => {
  it("короткая заметка остаётся одним куском", () => {
    const chunks = splitIntoChunks("Дробные позиции: среднее между соседями.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Дробные позиции: среднее между соседями.");
  });

  it("пустая заметка даёт ровно один кусок, а не ноль", () => {
    // Ноль кусков означал бы «не проиндексирована»: заметка попадала бы
    // в переиндексацию на каждом поиске и жгла бы вызовы API впустую.
    expect(splitIntoChunks("")).toEqual([""]);
    expect(splitIntoChunks("   \n\n  ")).toEqual([""]);
  });

  it("снимает разметку", () => {
    const chunks = splitIntoChunks("# Заголовок\n\nТекст с **жирным** и `кодом`.");

    expect(chunks[0]).toContain("Заголовок");
    expect(chunks[0]).toContain("Текст с жирным и кодом.");
    expect(chunks[0]).not.toContain("#");
    expect(chunks[0]).not.toContain("**");
  });

  it("не режет по решётке внутри блока кода", () => {
    const content = [
      "Ставим зависимости.",
      "",
      "```bash",
      "# это комментарий, а не заголовок",
      "npm install",
      "```",
      "",
      "Готово.",
    ].join("\n");

    // Один раздел: заголовков markdown в тексте нет.
    expect(splitIntoChunks(content)).toHaveLength(1);
  });

  it("режет длинную заметку по заголовкам и держит бюджет", () => {
    const section = (title: string) =>
      `## ${title}\n\n${"слово ".repeat(2_000)}`;

    const chunks = splitIntoChunks(
      [section("Первый"), section("Второй"), section("Третий")].join("\n\n"),
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("режет абзац, который сам длиннее бюджета", () => {
    const chunks = splitIntoChunks("а".repeat(CHUNK_MAX_CHARS * 2 + 500));

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });

  it("не теряет текст при нарезке", () => {
    const content = Array.from(
      { length: 40 },
      (_, i) => `## Раздел ${i}\n\nМаркер${i} ${"наполнитель ".repeat(60)}`,
    ).join("\n\n");

    const joined = splitIntoChunks(content).join(" ");

    // Каждый раздел обязан найтись хоть в одном куске.
    for (let i = 0; i < 40; i += 1) {
      expect(joined).toContain(`Маркер${i}`);
    }
  });

  it("реальный документ проекта режется, и каждый кусок в бюджете", () => {
    // docs/описание.md — примерно 22 тысячи символов, то есть заведомо
    // больше одного куска. Заодно проверяем работу на настоящем markdown
    // с таблицами, ссылками и блоками SQL.
    const content = readFileSync("docs/описание.md", "utf8");
    const chunks = splitIntoChunks(content);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    }
  });
});

describe("embeddingInput", () => {
  it("приписывает заголовок заметки к куску", () => {
    expect(embeddingInput("Сортировка", "среднее между соседями")).toBe(
      "Сортировка\n\nсреднее между соседями",
    );
  });

  it("для пустого куска отдаёт один заголовок", () => {
    // Заметка без текста должна находиться по названию.
    expect(embeddingInput("Сортировка", "")).toBe("Сортировка");
  });
});
