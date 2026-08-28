import { and, count, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { folders, type Folder } from "@/db/schema";
import { forbidden, notFound, targetFolderNotFound } from "@/lib/errors";
import { DEFAULT_POSITION, positionBetween } from "@/lib/position";
import { LIMITS } from "@/lib/validation";

/**
 * Все операции ниже ищут ресурс по паре (id, owner_id).
 * Запроса «найти папку по id, а потом сравнить владельца» здесь нет
 * намеренно: так невозможно забыть вторую половину проверки.
 */

export async function getOwnedFolder(
  ownerId: string,
  folderId: string,
): Promise<Folder> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.ownerId, ownerId),
        eq(folders.isArchived, false),
      ),
    );

  if (!folder) throw notFound();
  return folder;
}

/** Позиция в конце списка папок того же родителя. */
async function nextPosition(
  ownerId: string,
  parentId: string | null,
): Promise<string> {
  const [row] = await db
    .select({ max: sql<string | null>`max(${folders.position})::text` })
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, ownerId),
        parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
        eq(folders.isArchived, false),
      ),
    );

  return row?.max ? positionBetween(row.max, null).position : DEFAULT_POSITION;
}

export async function createFolder(
  ownerId: string,
  input: { title: string; parentId: string | null },
): Promise<Folder> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(folders)
    .where(and(eq(folders.ownerId, ownerId), eq(folders.isArchived, false)));

  if (total >= LIMITS.foldersPerUser) {
    throw forbidden();
  }

  // Родитель обязан принадлежать тому же пользователю. Триггер в БД
  // продублирует эту проверку, но клиенту нужна доменная ошибка.
  if (input.parentId) {
    const [parent] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.id, input.parentId),
          eq(folders.ownerId, ownerId),
          eq(folders.isArchived, false),
        ),
      );

    if (!parent) throw targetFolderNotFound();
  }

  const [folder] = await db
    .insert(folders)
    .values({
      ownerId,
      parentId: input.parentId,
      title: input.title,
      position: await nextPosition(ownerId, input.parentId),
    })
    .returning();

  return folder;
}

export async function renameFolder(
  ownerId: string,
  folderId: string,
  title: string,
): Promise<Folder> {
  const [folder] = await db
    .update(folders)
    .set({ title, updatedAt: new Date() })
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.ownerId, ownerId),
        eq(folders.isArchived, false),
      ),
    )
    .returning();

  if (!folder) throw notFound();
  return folder;
}

/**
 * Мягкое удаление: помечает архивной саму папку, все вложенные папки
 * и все заметки внутри них.
 *
 * Архивировать только саму папку нельзя — её дети перестали бы находить
 * родителя в выборке (она фильтруется по is_archived = false) и всплыли бы
 * в корень дерева.
 */
export async function archiveFolder(
  ownerId: string,
  folderId: string,
): Promise<void> {
  await getOwnedFolder(ownerId, folderId);

  // Один запрос вместо «прочитать поддерево, затем два UPDATE»:
  // data-modifying CTE выполняется атомарно и не гоняет список id
  // через параметры-массивы.
  await db.execute(sql`
    with recursive subtree as (
      select id, array[id] as path
      from folders
      where id = ${folderId}
        and owner_id = ${ownerId}

      union all

      select child.id, subtree.path || child.id
      from folders child
      join subtree on child.parent_id = subtree.id
      where child.owner_id = ${ownerId}
        -- Цикла в корректном дереве нет, но рекурсия не должна зависать,
        -- если инвариант когда-нибудь нарушат.
        and not child.id = any(subtree.path)
    ),
    archived_notes as (
      update notes
      set is_archived = true, updated_at = now()
      where owner_id = ${ownerId}
        and folder_id in (select id from subtree)
        and is_archived = false
      returning id
    )
    update folders
    set is_archived = true, updated_at = now()
    where owner_id = ${ownerId}
      and id in (select id from subtree)
      and is_archived = false
  `);
}
