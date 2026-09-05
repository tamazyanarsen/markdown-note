import { randomUUID } from "node:crypto";

import { and, count, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { attachments, notes, type Attachment } from "@/db/schema";
import { forbidden, notFound, uploadRejected } from "@/lib/errors";
import {
  deleteAttachmentFile,
  isAllowedMimeType,
  isInlineImage,
  saveAttachmentFile,
  type AllowedMimeType,
} from "@/lib/uploads";
import { LIMITS } from "@/lib/validation";

/**
 * Вложения заметок.
 *
 * Правило доступа одно и берётся у заметки: вложение видно ровно тем, кому
 * видна заметка, к которой оно прикреплено. Своей видимости у файла нет —
 * иначе появилась бы вторая модель прав, которую пришлось бы держать
 * согласованной с первой.
 */

/** Что уходит клиенту после загрузки — всё, что нужно, чтобы вставить ссылку. */
export interface UploadedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  /** Адрес для markdown. Тот же, по которому файл потом читают. */
  url: string;
  /** Картинку вставляем как `![…]()`, остальное — обычной ссылкой. */
  inline: boolean;
}

/**
 * Имя файла, пригодное для текста markdown-ссылки.
 *
 * Квадратная скобка закрыла бы ссылку раньше времени, перевод строки разорвал
 * бы её пополам. Длину режем, потому что имя целиком уходит в текст заметки,
 * а он и без того ограничен.
 */
function safeFilename(raw: string): string {
  const cleaned = [...raw]
    // Управляющие символы: перевод строки разорвал бы и ссылку, и заголовок
    // Content-Disposition. Сравниваем по коду, а не регуляркой с диапазоном —
    // такую регулярку невозможно прочитать глазами в исходнике.
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    // Квадратные скобки закрыли бы markdown-ссылку раньше времени.
    .replace(/[[\]]/g, "")
    .trim();

  return (cleaned || "файл").slice(0, 120);
}

/**
 * Загрузка файла в заметку.
 *
 * Порядок «сначала файл, потом строка» выбран сознательно: при падении
 * вставки файл удаляется тут же, а обратный порядок оставил бы в базе строку,
 * указывающую в никуда. Осиротевший файл — это занятое место, битая строка —
 * это сломанная картинка в заметке.
 */
export async function createAttachment(
  ownerId: string,
  noteId: string,
  file: { name: string; type: string; bytes: Buffer },
): Promise<UploadedAttachment> {
  if (!isAllowedMimeType(file.type)) {
    throw uploadRejected(
      `Такой файл загружать нельзя: ${file.type || "тип не определён"}.`,
    );
  }

  if (file.bytes.byteLength === 0) {
    throw uploadRejected("Файл пустой.");
  }

  if (file.bytes.byteLength > LIMITS.attachmentMaxBytes) {
    throw uploadRejected(
      `Файл больше ${Math.round(LIMITS.attachmentMaxBytes / 1024 / 1024)} МБ.`,
    );
  }

  // Пара (id, owner_id), как и везде: чужая заметка для нас не существует.
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    );

  if (!note) throw notFound();

  const [{ total }] = await db
    .select({ total: count() })
    .from(attachments)
    .where(eq(attachments.ownerId, ownerId));

  if (total >= LIMITS.attachmentsPerUser) throw forbidden();

  // Идентификатор нужен до записи файла: из него выводится путь.
  const id = randomUUID();
  const mimeType = file.type as AllowedMimeType;
  const filename = safeFilename(file.name);

  await saveAttachmentFile(ownerId, id, mimeType, file.bytes);

  try {
    await db.insert(attachments).values({
      id,
      ownerId,
      noteId,
      filename,
      mimeType,
      byteSize: file.bytes.byteLength,
    });
  } catch (error) {
    await deleteAttachmentFile(ownerId, id, mimeType);
    throw error;
  }

  return {
    id,
    filename,
    mimeType,
    byteSize: file.bytes.byteLength,
    url: `/api/files/${id}`,
    inline: isInlineImage(mimeType),
  };
}

/**
 * Вложение для произвольного посетителя.
 *
 * Права целиком наследуются от заметки: public — всем, private — только
 * владельцу. Архивная заметка не отдаёт ничего, как и её страница.
 *
 * Возвращает null, а не ошибку доступа, ровно по той же причине, что и
 * getNoteForViewer: 403 подтвердил бы, что файл с таким UUID существует.
 */
export async function getAttachmentForViewer(
  attachmentId: string,
  viewerId: string | null,
): Promise<Attachment | null> {
  const [row] = await db
    .select({ attachment: attachments, visibility: notes.visibility })
    .from(attachments)
    .innerJoin(notes, eq(notes.id, attachments.noteId))
    .where(and(eq(attachments.id, attachmentId), eq(notes.isArchived, false)));

  if (!row) return null;

  if (row.visibility === "public") return row.attachment;
  if (viewerId && row.attachment.ownerId === viewerId) return row.attachment;

  return null;
}
