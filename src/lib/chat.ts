/**
 * Генерация текста через MWS GPT Model Hub.
 *
 * Тот же OpenAI-совместимый API и та же пара MWS_BASE_URL / MWS_API_KEY,
 * что у эмбеддингов (src/lib/embeddings.ts) — отличается только эндпоинт.
 * Значит и переезд к другому совместимому провайдеру стоит смены тех же
 * переменных окружения, а не переписывания кода.
 */

/**
 * Модель по умолчанию не задана специально.
 *
 * У эмбеддингов она есть (bge-m3): размерность зашита в схему, и угадывать
 * там нечего. Здесь выбор широкий и меняется вместе с каталогом Model Hub,
 * поэтому имя обязан указать человек. Не указано — функция просто выключена,
 * ровно как поиск без ключа.
 */
const CHAT_MODEL_ENV = "MWS_CHAT_MODEL";

/**
 * Потолок ожидания.
 *
 * Меньше, чем proxy_read_timeout 60s в deploy/md-note-proxy.conf: обрыв
 * должен приходить от нас с внятным ответом, а не от nginx страницей 504.
 */
const TIMEOUT_MS = 45_000;

/**
 * Низкая, но не нулевая: ответ собирается из кусков заметок, и выдумывать
 * там нечего. Ноль у части моделей включает жадное декодирование с его
 * склонностью зацикливаться на повторах.
 */
const TEMPERATURE = 0.2;

/** Ответ длиной с абзац-два: это выжимка из заметок, а не сочинение. */
const MAX_TOKENS = 800;

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Настроен ли провайдер генерации.
 *
 * Три переменные, а не две: ключ и адрес общие с эмбеддингами, но имя модели
 * своё. Заполненный ключ без модели означает «поиск нужен, ответы нет».
 */
export function isChatEnabled(): boolean {
  return Boolean(
    process.env.MWS_API_KEY &&
      process.env.MWS_BASE_URL &&
      process.env[CHAT_MODEL_ENV],
  );
}

/**
 * Сообщения → текст ответа.
 *
 * Бросает при любой проблеме: недоступности, отказе, неожиданном ответе.
 * Ловит и превращает в «ответа нет, вот источники» доменный слой
 * (src/domain/ask.ts) — как и у embedTexts, решение о деградации доменное.
 */
export async function chatComplete(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.MWS_API_KEY;
  const baseUrl = process.env.MWS_BASE_URL;
  const model = process.env[CHAT_MODEL_ENV];

  if (!apiKey || !baseUrl || !model) {
    throw new Error(`MWS_API_KEY, MWS_BASE_URL или ${CHAT_MODEL_ENV} не заданы`);
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    // Тело урезаем: в него может попасть простыня html от прокси.
    const details = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`Генерация: ${response.status} ${details}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = payload.choices?.[0]?.message?.content?.trim();

  // Пустой ответ — это не ответ. Отдать пустую строку значило бы показать
  // человеку пустую карточку вместо честного «не получилось».
  if (!text) throw new Error("Генерация: пустой ответ модели");

  return text;
}
