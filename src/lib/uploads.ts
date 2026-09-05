import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Файлы вложений на диске.
 *
 * В базе лежат только метаданные (таблица attachments), байты — здесь.
 * Путь не хранится, а выводится из owner_id и id вложения: обе части —
 * UUID, выданные базой, расширение берётся из белого списка ниже. Значит
 * в путь физически не может попасть ни «..», ни имя файла из формы,
 * и обходить нечего — path traversal невозможен по построению, а не
 * по факту проверки, которую можно забыть.
 */

/**
 * Что разрешено загружать.
 *
 * SVG в списке нет намеренно: это не картинка, а документ со скриптами
 * внутри, и отдавать его с нашего домена значило бы открыть XSS в обход
 * всей санитизации markdown.
 *
 * Расширение берётся отсюда, а не из имени файла: «отчёт.png.html»
 * не должен попасть на диск как .html.
 */
export const ALLOWED_MIME_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
} as const;

export type AllowedMimeType = keyof typeof ALLOWED_MIME_TYPES;

export function isAllowedMimeType(value: string): value is AllowedMimeType {
  return value in ALLOWED_MIME_TYPES;
}

/**
 * Картинка вставляется в текст как `![…]()` и показывается прямо в заметке.
 * Всё остальное отдаётся с Content-Disposition: attachment — браузер такой
 * файл скачает, а не станет открывать у нас на домене.
 */
export function isInlineImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Заголовок Content-Disposition с именем файла.
 *
 * Только `filename*` в кодировке RFC 5987: имя приходит от человека и почти
 * наверняка кириллическое, а обычный `filename=` умеет лишь latin-1.
 * Кавычки и переводы строк в нём закрыли бы заголовок раньше времени —
 * encodeURIComponent убирает и то, и другое.
 */
export function contentDisposition(filename: string, inline: boolean): string {
  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Корень хранилища.
 *
 * Функция, а не константа модуля: в Docker каталог задаётся переменной
 * окружения и подключён томом, а тесты подменяют его на временный.
 * Константа зафиксировала бы значение на момент импорта.
 */
function uploadsRoot(): string {
  return (
    process.env.UPLOADS_DIR ||
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads")
  );
}

/**
 * Пометки `turbopackIgnore` на всех обращениях к файловой системе ниже —
 * не украшение. Сборщик видит путь, который не может вычислить статически,
 * считает его ссылкой на файлы проекта и на всякий случай тянет в
 * standalone-образ весь репозиторий вместе с public/. Здесь же путь
 * указывает не в проект, а в каталог данных, известный только в рантайме.
 */
export function attachmentPath(
  ownerId: string,
  attachmentId: string,
  mimeType: AllowedMimeType,
): string {
  return path.join(
    /*turbopackIgnore: true*/ uploadsRoot(),
    ownerId,
    `${attachmentId}.${ALLOWED_MIME_TYPES[mimeType]}`,
  );
}

export async function saveAttachmentFile(
  ownerId: string,
  attachmentId: string,
  mimeType: AllowedMimeType,
  bytes: Buffer,
): Promise<void> {
  const target = attachmentPath(ownerId, attachmentId, mimeType);

  await mkdir(/*turbopackIgnore: true*/ path.dirname(target), {
    recursive: true,
  });
  await writeFile(/*turbopackIgnore: true*/ target, bytes);
}

export async function readAttachmentFile(
  ownerId: string,
  attachmentId: string,
  mimeType: AllowedMimeType,
): Promise<Buffer> {
  return readFile(
    /*turbopackIgnore: true*/ attachmentPath(ownerId, attachmentId, mimeType),
  );
}

/**
 * Удаление файла после того, как строка в базе не появилась.
 *
 * Молча проглатывает отсутствие файла: это откат неудачной загрузки,
 * и «файла и так нет» — ровно тот результат, которого мы добивались.
 */
export async function deleteAttachmentFile(
  ownerId: string,
  attachmentId: string,
  mimeType: AllowedMimeType,
): Promise<void> {
  await unlink(
    /*turbopackIgnore: true*/ attachmentPath(ownerId, attachmentId, mimeType),
  ).catch(() => {});
}
