"use client";

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";

import type { SearchResult } from "@/domain/search";
import { apiFetch } from "@/lib/api-client";

/**
 * Ссылка на другую заметку по `[[`.
 *
 * В текст уходит обычная markdown-ссылка на permalink — `[[` живёт только
 * здесь, в редакторе, и до файла не доходит. Поэтому рендер, санитизация и
 * публичная страница о связях не знают ничего, а Obsidian-подобная привычка
 * набирать `[[` при этом работает.
 *
 * Адрес в ссылке — UUID, а не заголовок: переименование цели ссылку не ломает.
 * Обратное — текст ссылки после переименования остаётся старым, и это
 * известная плата за такое решение.
 */

/** Короче двух символов не ищем — так же считает searchQuerySchema. */
const MIN_QUERY_LENGTH = 2;

/**
 * Экранирование текста ссылки.
 *
 * Заголовок — произвольная строка до 200 символов, и квадратная скобка
 * в нём закрыла бы ссылку раньше времени: «[Заметка [1]](/n/…)» распадается
 * на текст и мусор. Обратный слеш экранируем первым, иначе он съел бы
 * добавленные нами слеши.
 */
function escapeLinkText(title: string): string {
  return title.replace(/\\/g, "\\\\").replace(/([[\]])/g, "\\$1");
}

async function completeNoteLink(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  // От `[[` до курсора. Закрывающая скобка и перевод строки прекращают
  // набор: то, что уже закрыто, дополнять нечем.
  const typed = context.matchBefore(/\[\[[^\]\n]*/);
  if (!typed) return null;

  const query = typed.text.slice(2).trim();
  if (query.length < MIN_QUERY_LENGTH) return null;

  // Только fts: он локальный и бесплатный. Смысловой слой здесь не нужен —
  // человек ищет конкретную заметку, название которой помнит.
  const controller = new AbortController();
  context.addEventListener("abort", () => controller.abort(), {
    onDocChange: true,
  });

  let result: SearchResult;
  try {
    result = await apiFetch<SearchResult>(
      `/api/search?q=${encodeURIComponent(query)}&mode=fts`,
      { signal: controller.signal },
    );
  } catch {
    // Отменённый запрос или отказ API. Показать нечего, но и ошибку
    // сообщать некуда: это выпадающий список, а не действие человека.
    return null;
  }

  if (result.hits.length === 0) return null;

  return {
    from: typed.from,
    to: context.pos,
    // Порядок задал сервер (ts_rank), пересортировывать его по совпадению
    // подстроки нельзя — тем более что сравнивалось бы «[[запрос»
    // с заголовком, и совпадений не нашлось бы вовсе.
    filter: false,
    options: result.hits.map((hit) => ({
      label: hit.title,
      detail: hit.snippet,
      apply: (view, _completion, from, to) => {
        const insert = `[${escapeLinkText(hit.title)}](/n/${hit.id})`;

        // closeBrackets из basicSetup дописывает закрывающую скобку на каждую
        // открытую, поэтому к моменту выбора справа от курсора висит `]]`.
        // Строка-заменитель их не трогает — и в тексте оставался бы хвост
        // «[Заголовок](/n/…)]]». Съедаем ровно то, что дописал редактор.
        const trailing = /^\]{1,2}/.exec(view.state.sliceDoc(to, to + 2));

        view.dispatch({
          changes: { from, to: to + (trailing?.[0].length ?? 0), insert },
          selection: { anchor: from + insert.length },
        });
      },
    })),
  };
}

/**
 * Источник регистрируется через данные языка, а не отдельным
 * `autocompletion()`: тот уже включён в basicSetup, и второй экземпляр
 * конфигурации подрался бы с первым за одно и то же состояние.
 */
export const wikiLinkCompletion: Extension = markdownLanguage.data.of({
  autocomplete: completeNoteLink,
});
