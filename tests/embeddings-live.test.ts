import { describe, expect, it } from "vitest";

import { EMBEDDING_DIMENSIONS } from "@/db/schema";
import { embedTexts, isSemanticEnabled } from "@/lib/embeddings";

/**
 * Живая проверка провайдера эмбеддингов.
 *
 * Единственный тест в проекте, который ходит в сеть и стоит денег — правда,
 * доли копейки: несколько коротких строк по 0,61 ₽ за миллион токенов.
 *
 * Без MWS_API_KEY пропускается целиком, поэтому `npm test` остаётся зелёным
 * и без ключа. Запускать его стоит после смены провайдера, модели или
 * размерности: остальные тесты работают с подставным векторизатором и
 * поэтому не заметят, что настоящий API отвечает не тем.
 */

/** Косинусная близость: 1 — одинаковые по смыслу, 0 — не связаны. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe.skipIf(!isSemanticEnabled())("провайдер эмбеддингов (живой вызов)", () => {
  it("отвечает векторами той размерности, что зашита в схему", async () => {
    const vectors = await embedTexts(["первый текст", "второй текст"]);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(vectors[1]).toHaveLength(EMBEDDING_DIMENSIONS);

    // Нулевой вектор сломал бы косинусное расстояние в pgvector.
    expect(vectors[0].some((value) => value !== 0)).toBe(true);
  });

  it("понимает русский: близкие по смыслу тексты ближе, чем чужие", async () => {
    // Ради этого свойства всё и затевалось. У запроса и подходящей заметки
    // нет ни одного общего слова, у неподходящей — тоже, так что
    // полнотекстовый поиск здесь не помог бы ни в ту, ни в другую сторону.
    const [query, relevant, unrelated] = await embedTexts([
      "как я делал дробную сортировку элементов",
      "position numeric(20,10), новое значение — среднее между соседями",
      "рецепт борща: свёкла, капуста, томатная паста",
    ]);

    const hit = cosine(query, relevant);
    const miss = cosine(query, unrelated);

    expect(hit).toBeGreaterThan(miss);
  });

  it("держит порядок ответа при разбиении на пачки", async () => {
    // BATCH_SIZE в embedTexts — 32, поэтому 40 строк уедут двумя запросами.
    // Если порядок собьётся, векторы окажутся привязаны не к тем заметкам,
    // и поиск начнёт молча врать.
    const texts = Array.from({ length: 40 }, (_, i) => `текст номер ${i}`);
    const vectors = await embedTexts(texts);

    expect(vectors).toHaveLength(40);

    const [again] = await embedTexts([texts[35]]);
    expect(cosine(vectors[35], again)).toBeGreaterThan(0.99);
  });
});
