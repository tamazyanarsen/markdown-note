import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "../client";
import { noteLinks, notes } from "../schema";

/**
 * Запросы по связям между заметками (note_links).
 *
 * Правило то же, что в search.ts: владелец проверяется внутри запроса.
 * Здесь это не оптимизация, а единственная защита — схема не знает, чьи
 * заметки связаны, и если пишущий запрос перестанет фильтровать по
 * owner_id, в графе появятся чужие заметки.
 */

/** Заметка в списке связей: заголовок плюс начало текста на превью. */
export interface LinkedNote {
  id: string;
  title: string;
  folderId: string | null;
  /** Начало markdown-исходника: полный content тянуть нельзя, он до 512 КБ. */
  preview: string;
}

/** Сколько символов заметки тянем на превью. */
const PREVIEW_CHARS = 400;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Переписывает исходящие связи заметки целиком.
 *
 * Транзакция передаётся снаружи: связи обязаны меняться тем же коммитом,
 * что и текст, из которого они вычитаны. Иначе упавшая вставка оставила бы
 * бэклинки от предыдущей редакции — и разошлись бы они молча.
 *
 * Цели сначала выбираются по паре id + owner_id и только потом вставляются.
 * Лишний запрос внутри транзакции — плата за то, что связь с чужой или
 * удалённой заметкой не появится, даже если ссылка на неё есть в тексте:
 * такой UUID просто не найдётся и выпадет из списка.
 */
export async function replaceNoteLinks(
  tx: Tx,
  sourceNoteId: string,
  ownerId: string,
  targetIds: string[],
): Promise<void> {
  await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, sourceNoteId));

  if (targetIds.length === 0) return;

  const targets = await tx
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        inArray(notes.id, targetIds),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
        // Ссылку на саму себя отбрасывает и extractNoteLinks, но на неё есть
        // ещё и check-ограничение в схеме — вставка упала бы всей транзакцией.
        ne(notes.id, sourceNoteId),
      ),
    );

  if (targets.length === 0) return;

  await tx
    .insert(noteLinks)
    .values(targets.map(({ id }) => ({ sourceNoteId, targetNoteId: id })));
}

/**
 * Заметки, которые ссылаются на заданную.
 *
 * Архивные исключены: они не видны в дереве, и ссылка из небытия сбивает
 * с толку. Восстановление заметки вернёт и её ссылки — таблица не менялась.
 */
export async function findBacklinks(
  ownerId: string,
  noteId: string,
  limit = 20,
): Promise<LinkedNote[]> {
  const rows = await db
    .select({
      id: notes.id,
      title: notes.title,
      folderId: notes.folderId,
      preview: sql<string>`left(${notes.content}, ${PREVIEW_CHARS})`,
    })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .where(
      and(
        eq(noteLinks.targetNoteId, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, false),
      ),
    )
    .orderBy(sql`${notes.updatedAt} desc`)
    .limit(limit);

  return rows;
}
