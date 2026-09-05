import { findChunksForNotes } from "@/db/queries/search";
import { chatComplete, isChatEnabled, type ChatMessage } from "@/lib/chat";

import { searchNotes, type Embedder, type SearchHit } from "./search";

/**
 * Вопрос к своим заметкам.
 *
 * Половина работы уже сделана поиском: гибридная выдача с векторами и RRF —
 * это и есть retrieval. Здесь добавляется только генерация поверх найденного,
 * причём строго поверх: модель получает куски заметок и запрет отвечать
 * из собственных знаний. Иначе вместо «в заметках такого нет» она уверенно
 * рассказала бы что-нибудь общеизвестное, и отличить одно от другого стало
 * бы невозможно.
 *
 * Ответ необязателен. answer === null означает «сгенерировать не вышло» —
 * модель не настроена, провайдер отказал или искать было не по чему.
 * Источники при этом остаются: найденные заметки полезны и без пересказа.
 * Тот же принцип, что у поиска без ключа, — деградировать, а не падать.
 */

/** Генератор ответа. Параметром — чтобы тесты не ходили в сеть. */
export type Completer = (messages: ChatMessage[]) => Promise<string>;

/** Сколько заметок уходит в контекст. Больше — дороже и мутнее. */
const CONTEXT_NOTES = 5;

/** Потолок на заметку: одна длинная не должна вытеснить остальные четыре. */
const CHARS_PER_NOTE = 4_000;

/** Общий потолок контекста — грубая защита от переполнения окна модели. */
const CHARS_TOTAL = 14_000;

const SYSTEM_PROMPT = `Ты помогаешь человеку искать ответы в его собственных заметках.

Правила:
— Отвечай только тем, что есть в приведённых фрагментах. Ничего не додумывай и не добавляй из общих знаний.
— Если во фрагментах ответа нет, так и скажи одной фразой. Это нормальный ответ, а не неудача.
— Ссылайся на фрагменты номерами в квадратных скобках: [1], [2].
— Отвечай по-русски, коротко и по делу. Markdown можно.`;

export interface AskResult {
  /** Сгенерированный ответ или null, если сгенерировать не удалось. */
  answer: string | null;
  /** Заметки, на которых ответ построен. Нумерация [1], [2] — их порядок. */
  sources: SearchHit[];
}

export async function askNotes(
  ownerId: string,
  question: string,
  options: { embed?: Embedder; complete?: Completer } = {},
): Promise<AskResult> {
  // Гибридный режим, а не полнотекстовый: вопрос задают словами, которых
  // в заметке может не быть вовсе — ровно тот случай, ради которого
  // смысловой слой и появился.
  const found = await searchNotes(ownerId, question, {
    mode: "hybrid",
    embed: options.embed,
  });

  const sources = found.hits.slice(0, CONTEXT_NOTES);
  if (sources.length === 0) return { answer: null, sources: [] };

  // Явно переданный генератор перебивает проверку окружения — так тест
  // включает ответы без настоящего ключа.
  const complete = options.complete ?? (isChatEnabled() ? chatComplete : null);
  if (!complete) return { answer: null, sources };

  try {
    const context = await buildContext(ownerId, sources);

    const answer = await complete([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Фрагменты заметок:\n\n${context}\n\nВопрос: ${question}`,
      },
    ]);

    return { answer, sources };
  } catch (error) {
    // Не пробрасываем: найденные заметки — уже полезный ответ, и отдать
    // 500 вместо них было бы худшим из вариантов. Ровно как в searchNotes.
    console.error("Ответ по заметкам не сгенерирован:", error);

    return { answer: null, sources };
  }
}

/**
 * Пронумерованные фрагменты для промпта.
 *
 * Номер и заголовок стоят перед текстом, чтобы модели было на что сослаться,
 * а человеку — что узнать в списке источников: нумерация в ответе совпадает
 * с порядком sources.
 *
 * Куски берутся из note_chunks, а не из notes.content: там уже очищенный
 * от разметки текст, тот же, что уходил в модель эмбеддингов.
 */
async function buildContext(
  ownerId: string,
  sources: SearchHit[],
): Promise<string> {
  const chunks = await findChunksForNotes(
    ownerId,
    sources.map((hit) => hit.id),
  );

  const byNote = new Map<string, string[]>();
  for (const chunk of chunks) {
    const texts = byNote.get(chunk.noteId) ?? [];
    texts.push(chunk.text);
    byNote.set(chunk.noteId, texts);
  }

  const blocks: string[] = [];
  let budget = CHARS_TOTAL;

  for (const [index, hit] of sources.entries()) {
    // Заметка без кусков ещё не проиндексирована — в контекст ей идти нечем,
    // но в источниках она остаётся: найдена-то она была.
    const text = (byNote.get(hit.id) ?? []).join("\n\n").slice(0, CHARS_PER_NOTE);
    if (!text) continue;

    const block = `[${index + 1}] ${hit.title}\n${text.slice(0, budget)}`;
    blocks.push(block);

    budget -= text.length;
    if (budget <= 0) break;
  }

  return blocks.join("\n\n---\n\n");
}
