import { markdownToPlainText } from "./markdown";

/**
 * Нарезка заметки на куски под окно модели эмбеддингов.
 *
 * Окно bge-m3 — 8192 токена. Токенизатор в Node не тащим ради проверки,
 * которая срабатывает редко: считаем по символам с запасом. Для русского
 * выходит 2–3 символа на токен, то есть 12 000 символов — это 4–6 тысяч
 * токенов, заметно ниже потолка даже при худшем соотношении.
 *
 * Запас сознательно перекошен в одну сторону: разрезать лишний раз безвредно,
 * а не разрезать когда надо — значит молча потерять хвост заметки (её лимит —
 * 512 КБ, LIMITS.contentMaxLength). Поиск при этом выглядел бы рабочим.
 */
export const CHUNK_MAX_CHARS = 12_000;

/**
 * Заметка → куски очищенного от разметки текста.
 *
 * Режем по заголовкам markdown, затем по абзацам, в последнюю очередь — по
 * границе слова. Заголовок раздела остаётся внутри своего куска сам собой:
 * markdownToPlainText превращает «## Раздел» в обычный текст.
 *
 * Заголовок самой заметки сюда не подмешивается: этот текст показывается
 * пользователю как сниппет, а заголовок он и так видит строкой выше.
 * Для модели заголовок приписывается отдельно — см. embeddingInput.
 */
export function splitIntoChunks(
  content: string,
  maxChars = CHUNK_MAX_CHARS,
): string[] {
  const chunks: string[] = [];

  for (const section of splitByHeadings(content)) {
    const plain = markdownToPlainText(section);
    if (!plain) continue;

    if (plain.length <= maxChars) {
      chunks.push(plain);
    } else {
      chunks.push(...splitLongSection(section, maxChars));
    }
  }

  // Пустая заметка обязана дать ровно один кусок. Вернув пустой список, мы
  // оставили бы её без строк в note_chunks — а «строк нет» означает
  // «не проиндексирована», и каждый поиск пересчитывал бы её заново.
  // Найтись по заголовку она при этом всё равно должна.
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Текст, который уходит в модель.
 *
 * Заголовок заметки приписывается к каждому куску: без него второй и
 * последующие куски теряют контекст — «см. таблицу выше» само по себе
 * не значит ничего.
 */
export function embeddingInput(title: string, chunk: string): string {
  return chunk ? `${title}\n\n${chunk}` : title;
}

/**
 * Разбивает markdown на разделы по заголовкам, заголовок остаётся со своим
 * разделом. Состояние ограждённого блока отслеживается: «# comment» внутри
 * ```-блока — это код на bash, а не заголовок.
 */
function splitByHeadings(markdown: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let insideFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) insideFence = !insideFence;

    if (!insideFence && /^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }

    current.push(line);
  }

  if (current.length > 0) sections.push(current.join("\n"));
  return sections;
}

/** Раздел, не влезающий в бюджет: набираем куски из абзацев. */
function splitLongSection(section: string, maxChars: number): string[] {
  const paragraphs = section
    .split(/\n\s*\n/)
    .map(markdownToPlainText)
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  for (const paragraph of paragraphs) {
    for (const piece of splitByWords(paragraph, maxChars)) {
      if (!buffer) {
        buffer = piece;
      } else if (buffer.length + 1 + piece.length <= maxChars) {
        buffer = `${buffer} ${piece}`;
      } else {
        chunks.push(buffer);
        buffer = piece;
      }
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

/** Абзац, который сам длиннее бюджета: режем по последнему пробелу. */
function splitByWords(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const pieces: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    const space = rest.lastIndexOf(" ", maxChars);
    // Пробела нет вовсе — например, сплошная строка base64: режем по границе.
    const cut = space > 0 ? space : maxChars;

    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) pieces.push(rest);
  return pieces;
}
