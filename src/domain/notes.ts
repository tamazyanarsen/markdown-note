import { and, count, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { folders, notes, type NoteView, type NoteVisibility } from "@/db/schema";
import { forbidden, notFound, targetFolderNotFound } from "@/lib/errors";
import { renderMarkdown } from "@/lib/markdown";
import { DEFAULT_POSITION, positionBetween } from "@/lib/position";
import { LIMITS } from "@/lib/validation";

/**
 * Колонки, которые заметке можно показывать наружу.
 *
 * Перечислены явно, а не через select(): иначе в JSON и в пропсы редактора
 * уезжали бы ещё и searchVector с contentHtml — оба клиенту не нужны и оба
 * сопоставимы по размеру с самим текстом заметки.
 */
export const noteColumns = {
  id: notes.id,
  ownerId: notes.ownerId,
  folderId: notes.folderId,
  title: notes.title,
  visibility: notes.visibility,
  content: notes.content,
  position: notes.position,
  isArchived: notes.isArchived,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
} as const;

export async function getOwnedNote(
  ownerId: string,
  noteId: string,
): Promise<NoteView> {
  const [note] = await db
    .select(noteColumns)
    .from(notes)
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    );

  if (!note) throw notFound();
  return note;
}

/**
 * Заметка вместе с кешем рендера.
 *
 * Кеш лежит рядом, а не внутри note, чтобы его нельзя было случайно передать
 * в клиентский компонент вместе с самой заметкой: NoteView для этого и нужен.
 */
export interface ViewerNote {
  note: NoteView;
  contentHtml: string | null;
}

/**
 * Заметка для произвольного посетителя страницы /n/:id.
 *
 * Владелец видит свою заметку всегда. Все остальные — только public.
 * Возвращается null, а не ошибка доступа: страница обязана ответить 404,
 * иначе 403 подтвердил бы, что private-заметка с таким UUID существует.
 */
export async function getNoteForViewer(
  noteId: string,
  viewerId: string | null,
): Promise<ViewerNote | null> {
  const [row] = await db
    .select({ ...noteColumns, contentHtml: notes.contentHtml })
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.isArchived, false)));

  if (!row) return null;

  const { contentHtml, ...note } = row;

  if (note.visibility === "public") return { note, contentHtml };
  if (viewerId && note.ownerId === viewerId) return { note, contentHtml };

  return null;
}

/** Позиция в конце списка заметок той же папки. */
async function nextPosition(
  ownerId: string,
  folderId: string | null,
): Promise<string> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${notes.position})::text` })
    .from(notes)
    .where(
      and(
        eq(notes.ownerId, ownerId),
        folderId === null ? isNull(notes.folderId) : eq(notes.folderId, folderId),
        eq(notes.isArchived, false),
      ),
    );

  return row?.max ? positionBetween(row.max, null).position : DEFAULT_POSITION;
}

export async function createNote(
  ownerId: string,
  input: { title: string; folderId: string | null; content?: string },
): Promise<NoteView> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(notes)
    .where(and(eq(notes.ownerId, ownerId), eq(notes.isArchived, false)));

  if (total >= LIMITS.notesPerUser) {
    throw forbidden();
  }

  if (input.folderId) {
    const [folder] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.id, input.folderId),
          eq(folders.ownerId, ownerId),
          eq(folders.isArchived, false),
        ),
      );

    if (!folder) throw targetFolderNotFound();
  }

  const [note] = await db
    .insert(notes)
    .values({
      ownerId,
      folderId: input.folderId,
      title: input.title,
      content: input.content ?? "",
      position: await nextPosition(ownerId, input.folderId),
    })
    .returning(noteColumns);

  return note;
}

export async function updateNote(
  ownerId: string,
  noteId: string,
  input: { title?: string; content?: string },
): Promise<NoteView> {
  const [note] = await db
    .update(notes)
    .set({
      ...input,
      // Правка текста делает кеш рендера недействительным. Правка одного
      // заголовка — нет: в html заголовок не входит, его печатает страница.
      ...(input.content === undefined ? {} : { contentHtml: null }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    )
    .returning(noteColumns);

  if (!note) throw notFound();
  return note;
}

/**
 * Готовый html публичной заметки.
 *
 * cached: false означает, что html только что посчитан и его стоит сохранить
 * через saveNoteHtml — но уже после ответа, чтобы не задерживать страницу.
 * Планирование этой отложенной работы — забота слоя HTTP, а не домена.
 */
export async function renderNoteHtml({
  note,
  contentHtml,
}: ViewerNote): Promise<{ html: string; cached: boolean }> {
  if (contentHtml !== null) return { html: contentHtml, cached: true };

  return { html: await renderMarkdown(note.content), cached: false };
}

/**
 * Кладёт посчитанный html в кеш.
 *
 * Условие на content отсекает гонку с автосохранением: если между чтением
 * и записью текст успел измениться, html уже устарел и записывать его нельзя.
 * updatedAt намеренно не трогаем — это не правка заметки.
 */
export async function saveNoteHtml(
  noteId: string,
  renderedFrom: string,
  html: string,
): Promise<void> {
  await db
    .update(notes)
    .set({ contentHtml: html })
    .where(and(eq(notes.id, noteId), eq(notes.content, renderedFrom)));
}

/** POST /api/notes/:id/publish и /make-private. */
export async function setNoteVisibility(
  ownerId: string,
  noteId: string,
  visibility: NoteVisibility,
): Promise<NoteView> {
  // contentHtml не сбрасываем: текст не менялся, а значит и рендер прежний.
  const [note] = await db
    .update(notes)
    .set({ visibility, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    )
    .returning(noteColumns);

  if (!note) throw notFound();
  return note;
}

export async function archiveNote(ownerId: string, noteId: string): Promise<void> {
  const [note] = await db
    .update(notes)
    .set({ isArchived: true, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    )
    .returning({ id: notes.id });

  if (!note) throw notFound();
}
