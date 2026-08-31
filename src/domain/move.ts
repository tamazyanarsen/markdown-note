import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { folders, notes, type Folder, type NoteView } from "@/db/schema";
import { noteColumns } from "@/domain/notes";
import {
  folderMoveCycle,
  forbidden,
  notFound,
  ownerMismatch,
  targetFolderNotFound,
} from "@/lib/errors";
import { positionBetween, rebalancedPositions } from "@/lib/position";

/**
 * Перемещение — самая опасная операция в системе: она меняет структуру
 * дерева и потенциально способна смешать данные разных владельцев.
 *
 * Поэтому здесь:
 *  - вся работа идёт в одной транзакции;
 *  - и перемещаемый ресурс, и целевая папка берутся SELECT ... FOR UPDATE,
 *    чтобы параллельный move не увёл папку из-под проверки;
 *  - владелец проверяется у обоих ресурсов, а не только у одного;
 *  - для папок отдельно проверяется цикл.
 *
 * Триггеры в БД дублируют проверку владельца. Они — страховка, а не
 * замена: пользователю нужна доменная ошибка, а не текст исключения plpgsql.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface MoveInput {
  targetFolderId: string | null;
  position?: string;
}

/** Целевая папка существует, не архивна и принадлежит тому же владельцу. */
async function lockTargetFolder(
  tx: Tx,
  ownerId: string,
  targetFolderId: string,
): Promise<void> {
  const target = await tx.execute<{ owner_id: string }>(sql`
    select owner_id
    from folders
    where id = ${targetFolderId}
      and is_archived = false
    for update
  `);

  const row = target.rows[0];
  if (!row) throw targetFolderNotFound();
  if (row.owner_id !== ownerId) throw ownerMismatch();
}

/**
 * Позиция для вставки.
 *
 * Клиент считает её тем же positionBetween и присылает в теле запроса —
 * это контракт из документа. Если позиции нет, кладём в конец списка.
 */
async function resolvePosition(
  tx: Tx,
  table: "folders" | "notes",
  parentColumn: "parent_id" | "folder_id",
  ownerId: string,
  parentId: string | null,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) return requested;

  const result = await tx.execute<{ max: string | null }>(sql`
    select max(position)::text as max
    from ${sql.identifier(table)}
    where owner_id = ${ownerId}
      and ${sql.identifier(parentColumn)} is not distinct from ${parentId}
      and is_archived = false
  `);

  const max = result.rows[0]?.max;
  return max ? positionBetween(max, null).position : "1000";
}

/**
 * Перенумеровывает соседей ровными шагами, если дробить позиции стало
 * нечего: два одинаковых значения или зазор меньше 10^-6.
 *
 * Без этого после трёх десятков перетаскиваний между одной и той же парой
 * элементов порядок начал бы «залипать»: новая позиция совпадала бы
 * с соседней и элементы менялись бы местами произвольно.
 */
async function rebalanceIfNeeded(
  tx: Tx,
  table: "folders" | "notes",
  parentColumn: "parent_id" | "folder_id",
  ownerId: string,
  parentId: string | null,
): Promise<void> {
  const siblings = await tx.execute<{ id: string; position: string }>(sql`
    select id, position::text as position
    from ${sql.identifier(table)}
    where owner_id = ${ownerId}
      and ${sql.identifier(parentColumn)} is not distinct from ${parentId}
      and is_archived = false
    order by position, id
  `);

  const rows = siblings.rows;
  if (rows.length < 2) return;

  const needsRebalance = rows.some((row, index) => {
    if (index === 0) return false;
    const gap = Number(row.position) - Number(rows[index - 1].position);
    return gap < 1e-6;
  });

  if (!needsRebalance) return;

  const positions = rebalancedPositions(rows.length);

  // updated_at намеренно не трогаем: перенумерация — служебная операция,
  // а не правка заметки.
  for (const [index, row] of rows.entries()) {
    await tx.execute(sql`
      update ${sql.identifier(table)}
      set position = ${positions[index]}
      where id = ${row.id}
    `);
  }
}

export async function moveNote(
  ownerId: string,
  noteId: string,
  input: MoveInput,
): Promise<NoteView> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ owner_id: string }>(sql`
      select owner_id
      from notes
      where id = ${noteId}
        and is_archived = false
      for update
    `);

    const note = locked.rows[0];
    if (!note) throw notFound();
    if (note.owner_id !== ownerId) throw forbidden();

    if (input.targetFolderId !== null) {
      await lockTargetFolder(tx, ownerId, input.targetFolderId);
    }

    const position = await resolvePosition(
      tx,
      "notes",
      "folder_id",
      ownerId,
      input.targetFolderId,
      input.position,
    );

    // Обновление идёт через drizzle, а не сырым SQL: так ответ приходит
    // в том же camelCase, что и у остальных эндпоинтов.
    // visibility при перемещении не меняется: private остаётся private.
    const [updated] = await tx
      .update(notes)
      .set({
        folderId: input.targetFolderId,
        position,
        updatedAt: new Date(),
      })
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
      .returning(noteColumns);

    await rebalanceIfNeeded(tx, "notes", "folder_id", ownerId, input.targetFolderId);

    return updated;
  });
}

export async function moveFolder(
  ownerId: string,
  folderId: string,
  input: MoveInput,
): Promise<Folder> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ owner_id: string }>(sql`
      select owner_id
      from folders
      where id = ${folderId}
        and is_archived = false
      for update
    `);

    const folder = locked.rows[0];
    if (!folder) throw notFound();
    if (folder.owner_id !== ownerId) throw forbidden();

    if (input.targetFolderId !== null) {
      // Папку нельзя положить в саму себя — это частный случай цикла,
      // но проверяется отдельно: recursive CTE ниже начинается с неё же.
      if (input.targetFolderId === folderId) throw folderMoveCycle();

      await lockTargetFolder(tx, ownerId, input.targetFolderId);

      const cycle = await tx.execute<{ target_is_descendant: boolean }>(sql`
        with recursive subtree as (
          select id, parent_id, array[id] as path
          from folders
          where id = ${folderId}

          union all

          select child.id, child.parent_id, subtree.path || child.id
          from folders child
          join subtree on child.parent_id = subtree.id
          where child.is_archived = false
            and not child.id = any(subtree.path)
        )
        select exists (
          select 1 from subtree where id = ${input.targetFolderId}
        ) as target_is_descendant
      `);

      if (cycle.rows[0]?.target_is_descendant) throw folderMoveCycle();
    }

    const position = await resolvePosition(
      tx,
      "folders",
      "parent_id",
      ownerId,
      input.targetFolderId,
      input.position,
    );

    // Вложенное содержимое остаётся на месте относительно папки:
    // меняется только parent_id самой переносимой папки.
    const [updated] = await tx
      .update(folders)
      .set({
        parentId: input.targetFolderId,
        position,
        updatedAt: new Date(),
      })
      .where(and(eq(folders.id, folderId), eq(folders.ownerId, ownerId)))
      .returning();

    await rebalanceIfNeeded(tx, "folders", "parent_id", ownerId, input.targetFolderId);

    return updated;
  });
}
