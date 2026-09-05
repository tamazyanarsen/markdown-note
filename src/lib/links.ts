import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Root } from "mdast";

/**
 * Связи между заметками.
 *
 * Отдельного синтаксиса вроде [[uuid]] нет: `[[` в редакторе — только
 * автодополнение (src/components/note/wiki-link.ts), а в текст уходит обычная
 * markdown-ссылка на permalink. Поэтому рендер, санитизация, публичная
 * страница и экспорт не знают о связях вообще ничего, а здесь остаётся
 * только вычитать ссылки обратно.
 *
 * Плата за такое решение одна: переименование заметки не меняет текст ссылок
 * на неё. Сам адрес при этом не ломается — он и задуман неизменным.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Ссылка на заметку — и относительная, и вставленная целиком из адресной
 * строки. Второй случай не экзотика: скопировать адрес открытой заметки
 * проще, чем набрать `[[`.
 */
const NOTE_HREF = new RegExp(`^(?:https?://[^/]+)?/n/(${UUID})(?:[/?#].*)?$`, "i");

/** parse, а не process: нужно только дерево, рендерить нечего. */
const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * UUID заметок, на которые ссылается текст.
 *
 * Разбор идёт по AST, а не регуляркой по всему тексту: `/n/…` внутри
 * ```-блока — это пример в документации, а не ссылка, и попадать
 * в граф связей он не должен.
 *
 * Ссылка на саму себя отбрасывается: она не связь, а самоцитирование,
 * и в базе от неё стоит check-ограничение.
 */
export function extractNoteLinks(markdown: string, selfId?: string): string[] {
  const tree = parser.parse(markdown) as Root;
  const found = new Set<string>();

  // definition — ссылки в справочной форме: [текст][метка] и «[метка]: /n/…».
  // У узла image тот же url, но картинка на заметку связью не считается.
  visit(tree, ["link", "definition"], (node) => {
    const url = "url" in node && typeof node.url === "string" ? node.url : "";
    const match = NOTE_HREF.exec(url);
    if (!match) return;

    const id = match[1].toLowerCase();
    if (id !== selfId) found.add(id);
  });

  return [...found];
}
