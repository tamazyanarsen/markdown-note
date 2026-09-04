import { EMBEDDING_DIMENSIONS } from "@/db/schema";

/**
 * Векторизация текста через MWS GPT Model Hub.
 *
 * API OpenAI-совместимый, поэтому здесь обычный fetch без SDK. Побочная
 * выгода важнее экономии зависимости: переезд на другого совместимого
 * провайдера (например, Yandex AI Studio) — это смена MWS_BASE_URL,
 * MWS_EMBEDDING_MODEL и размерности колонки, а не переписывание кода.
 *
 * Ключ сервисного аккаунта уходит в Authorization напрямую: обмена на
 * временный токен, как у GigaChat, здесь нет.
 */

const DEFAULT_MODEL = "bge-m3";

/**
 * Потолок ожидания. Поиск обязан деградировать до полнотекстового быстрее,
 * чем пользователь решит, что интерфейс завис.
 */
const TIMEOUT_MS = 15_000;

/**
 * Сколько текстов уходит в один запрос.
 *
 * Первый в жизни поиск индексирует сразу всю базу, а кусок — до 12 000
 * символов (CHUNK_MAX_CHARS). Без разбиения тело запроса разрослось бы
 * до мегабайтов на ровном месте.
 */
const BATCH_SIZE = 32;

/**
 * Настроен ли внешний провайдер.
 *
 * Пустой ключ — не ошибка, а штатный режим: поиск работает полнотекстово.
 * Тот же принцип, что у OAuth-провайдеров в .env.example — не заполнен,
 * значит просто выключен.
 */
export function isSemanticEnabled(): boolean {
  return Boolean(process.env.MWS_API_KEY && process.env.MWS_BASE_URL);
}

/**
 * Тексты → векторы, в том же порядке.
 *
 * Бросает при любой проблеме: недоступности, отказе, неожиданном ответе.
 * Ловит и превращает в полнотекстовый режим доменный слой (src/domain/search.ts),
 * потому что решение «искать хуже, но искать» — доменное, а не транспортное.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.MWS_API_KEY;
  const baseUrl = process.env.MWS_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error("MWS_API_KEY или MWS_BASE_URL не заданы");
  }

  const model = process.env.MWS_EMBEDDING_MODEL || DEFAULT_MODEL;
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;

  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    vectors.push(...(await embedBatch(url, apiKey, model, batch)));
  }

  return vectors;
}

async function embedBatch(
  url: string,
  apiKey: string,
  model: string,
  batch: string[],
): Promise<number[][]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: batch }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Тело урезаем: в него может попасть простыня html от прокси.
    const details = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Эмбеддинги: ${response.status} ${details}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ index?: number; embedding?: number[] }>;
  };

  const data = payload.data;
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new Error(
      `Эмбеддинги: ожидали ${batch.length} векторов, получили ${data?.length ?? 0}`,
    );
  }

  // Порядок восстанавливаем по index, а не полагаемся на порядок массива.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  return ordered.map((item) => {
    const embedding = item.embedding;

    // Проверяем здесь, а не при вставке: Postgres на несовпадении
    // размерности ответит ошибкой про тип vector, и настоящая причина
    // — не та модель в конфиге — потеряется.
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Эмбеддинги: ожидали вектор длины ${EMBEDDING_DIMENSIONS}, получили ${
          embedding?.length ?? "не массив"
        }. Модель в MWS_EMBEDDING_MODEL не совпадает со схемой.`,
      );
    }

    return embedding;
  });
}
