import { and, count, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { folders, notes, type Note, type NoteVisibility } from "@/db/schema";
import { forbidden, notFound, targetFolderNotFound } from "@/lib/errors";
import { DEFAULT_POSITION, positionBetween } from "@/lib/position";
import { LIMITS } from "@/lib/validation";

export async function getOwnedNote(ownerId: string, noteId: string): Promise<Note> {
  const [note] = await db
    .select()
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
 * Заметка для произвольного посетителя страницы /n/:id.
 *
 * Владелец видит свою заметку всегда. Все остальные — только public.
 * Возвращается null, а не ошибка доступа: страница обязана ответить 404,
 * иначе 403 подтвердил бы, что private-заметка с таким UUID существует.
 */
export async function getNoteForViewer(
  noteId: string,
  viewerId: string | null,
): Promise<Note | null> {
  const [note] = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.isArchived, false)));

  if (!note) return null;
  if (note.visibility === "public") return note;
  if (viewerId && note.ownerId === viewerId) return note;

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
): Promise<Note> {
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
    .returning();

  return note;
}

export async function updateNote(
  ownerId: string,
  noteId: string,
  input: { title?: string; content?: string },
): Promise<Note> {
  const [note] = await db
    .update(notes)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    )
    .returning();

  if (!note) throw notFound();
  return note;
}

/** POST /api/notes/:id/publish и /make-private. */
export async function setNoteVisibility(
  ownerId: string,
  noteId: string,
  visibility: NoteVisibility,
): Promise<Note> {
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
    .returning();

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
