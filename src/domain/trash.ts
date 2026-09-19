import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db/client";
import { attachments, folders, notes, type Folder, type NoteView } from "@/db/schema";
import { notFound } from "@/lib/errors";
import {
  deleteAttachmentFile,
  isAllowedMimeType,
  type AllowedMimeType,
} from "@/lib/uploads";

import { nextFolderPosition } from "./folders";
import { nextNotePosition, noteColumns } from "./notes";

/**
 * Корзина.
 *
 * Удаление в проекте мягкое: archiveNote и archiveFolder ставят
 * is_archived вместе с archived_at, строки остаются на месте. Здесь живёт
 * всё, что с ними происходит дальше — список, восстановление и физическое
 * удаление вместе с файлами вложений.
 *
 * Группа — это то, что удалили одним действием. Отдельного признака у неё
 * нет и не нужно: archiveFolder — один запрос, а значит одна транзакция,
 * а значит одно и то же now() у всех затронутых строк. Поэтому «папка и её
 * содержимое» = «одинаковый archived_at внутри поддерева», а ветка,
 * отправленная в корзину раньше и отдельно, сохраняет свой archived_at
 * и остаётся в списке самостоятельной строкой.
 *
 * Как и везде в проекте, каждый запрос ищет ресурс по паре (id, owner_id):
 * чужая строка для нас не существует.
 */

/**
 * Сколько корзина хранит удалённое.
 *
 * Срок считается от archived_at. Всё, что старше, удаляется физически
 * при следующем открытии корзины — см. purgeExpired.
 */
export const TRASH_RETENTION_DAYS = 30;

export interface TrashItem {
  kind: "folder" | "note";
  id: string;
  title: string;
  archivedAt: Date;
  /** Сколько заметок уедет вместе с папкой. У заметки не заполняется. */
  noteCount?: number;
}

/**
 * Поддерево одной группы: сама папка и те её потомки, что попали в корзину
 * тем же действием.
 *
 * Фрагмент общий для restoreFolder и purgeFolder — обеим нужен один и тот же
 * набор строк, и расхождение между ними означало бы, что восстанавливается
 * не то же самое, что удаляется.
 *
 * Сравнение archived_at идёт с родителем по цепочке, а не с корнем: внутри
 * группы значения и так равны, а ветка с другим archived_at обрывает обход
 * на себе и остаётся в корзине.
 */
function groupFolders(ownerId: string, folderId: string): SQL {
  return sql`
    group_folders as (
      select f.id, f.archived_at, array[f.id] as path
      from folders f
      where f.id = ${folderId}
        and f.owner_id = ${ownerId}
        and f.is_archived = true

      union all

      select child.id, child.archived_at, gf.path || child.id
      from folders child
      join group_folders gf on child.parent_id = gf.id
      where child.owner_id = ${ownerId}
        and child.is_archived = true
        and child.archived_at = gf.archived_at
        -- Цикла в корректном дереве нет, но рекурсия не должна зависать,
        -- если инвариант когда-нибудь нарушат.
        and not child.id = any(gf.path)
    )
  `;
}

/** Файлы вложений, которые уедут вместе со строками. Читаются до удаления. */
type DoomedFile = {
  id: string;
  mimeType: string;
};

/**
 * Удаление файлов после того, как строки в базе уже нет.
 *
 * Порядок «сначала база, потом диск» обратный тому, что в createAttachment,
 * и по той же причине: там страховались от строки, указывающей в никуда,
 * здесь — от файла, на который больше некому сослаться. Осиротевший файл
 * это занятое место, битая ссылка — сломанная картинка.
 *
 * Неизвестный mime_type пропускаем: пути для него всё равно не построить,
 * а попасть в базу он мог только из версии с другим белым списком.
 */
async function deleteFiles(ownerId: string, files: DoomedFile[]): Promise<void> {
  await Promise.all(
    files
      .filter((file): file is DoomedFile & { mimeType: AllowedMimeType } =>
        isAllowedMimeType(file.mimeType),
      )
      .map((file) => deleteAttachmentFile(ownerId, file.id, file.mimeType)),
  );
}

/**
 * Строка ответа как её отдаёт драйвер.
 *
 * Даты и bigint приходят строками: db.execute идёт мимо разбора типов
 * drizzle, а тот для timestamptz и count() возвращает текст, чтобы не
 * терять точность по дороге. Приведение — ниже, в listTrash.
 */
type TrashRow = {
  kind: "folder" | "note";
  id: string;
  title: string;
  archived_at: string;
  note_count: string | null;
};

/**
 * Что показать в корзине.
 *
 * Возвращаются только вершины групп: удалённая папка с полусотней заметок
 * внутри — одна строка, а не пятьдесят одна. Вершиной считается строка,
 * чей родитель либо жив, либо отсутствует, либо попал в корзину другим
 * действием.
 *
 * Здесь же запускается автоочистка. Cron проекту не нужен: он уже живёт
 * по принципу ленивых производных — векторы пересчитываются к ближайшему
 * поиску, html рендерится к первому открытию. Срок корзины считается от
 * archived_at, поэтому «просрочено» не зависит от того, когда мы это
 * заметили.
 */
export async function listTrash(ownerId: string): Promise<TrashItem[]> {
  await purgeExpired(ownerId);

  const result = await db.execute<TrashRow>(sql`
    with recursive folder_roots as (
      select f.id, f.title, f.archived_at
      from folders f
      left join folders parent on parent.id = f.parent_id
      where f.owner_id = ${ownerId}
        and f.is_archived = true
        and (
          f.parent_id is null
          or parent.is_archived = false
          or parent.archived_at <> f.archived_at
        )
    ),
    group_tree as (
      select r.id as root_id, r.id as folder_id, r.archived_at, array[r.id] as path
      from folder_roots r

      union all

      select gt.root_id, child.id, child.archived_at, gt.path || child.id
      from folders child
      join group_tree gt on child.parent_id = gt.folder_id
      where child.owner_id = ${ownerId}
        and child.is_archived = true
        and child.archived_at = gt.archived_at
        and not child.id = any(gt.path)
    ),
    note_counts as (
      select gt.root_id, count(n.id) as note_count
      from group_tree gt
      left join notes n
        on n.folder_id = gt.folder_id
       and n.owner_id = ${ownerId}
       and n.is_archived = true
       and n.archived_at = gt.archived_at
      group by gt.root_id
    )
    select
      'folder' as kind,
      r.id,
      r.title,
      r.archived_at,
      coalesce(c.note_count, 0)::text as note_count
    from folder_roots r
    left join note_counts c on c.root_id = r.id

    union all

    select
      'note' as kind,
      n.id,
      n.title,
      n.archived_at,
      null as note_count
    from notes n
    left join folders f on f.id = n.folder_id
    where n.owner_id = ${ownerId}
      and n.is_archived = true
      and (
        n.folder_id is null
        or f.is_archived = false
        or f.archived_at <> n.archived_at
      )

    order by archived_at desc, title asc
  `);

  return result.rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    title: row.title,
    archivedAt: new Date(row.archived_at),
    ...(row.kind === "folder" ? { noteCount: Number(row.note_count ?? 0) } : {}),
  }));
}

/**
 * Вернуть заметку из корзины.
 *
 * Если папка осталась в корзине, заметка всплывает в корень — иначе её
 * не пустил бы туда триггер notes_owner_matches_folder_owner: он требует
 * живую целевую папку. Поэтому про папку решаем до того, как снимать флаг,
 * и обе правки уходят одним update.
 */
export async function restoreNote(
  ownerId: string,
  noteId: string,
): Promise<NoteView> {
  const [row] = await db
    .select({ folderId: notes.folderId, folderArchived: folders.isArchived })
    .from(notes)
    .leftJoin(folders, eq(folders.id, notes.folderId))
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, true),
      ),
    );

  if (!row) throw notFound();

  const uplift = row.folderId !== null && row.folderArchived === true;

  // Прежняя позиция считалась относительно соседей по старой папке,
  // в корне она не значит ничего — берём место в конце.
  const position = uplift ? await nextNotePosition(ownerId, null) : undefined;

  const [note] = await db
    .update(notes)
    .set({
      isArchived: false,
      archivedAt: null,
      updatedAt: new Date(),
      ...(uplift ? { folderId: null, position } : {}),
    })
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, true),
      ),
    )
    .returning(noteColumns);

  if (!note) throw notFound();
  return note;
}

/**
 * Вернуть папку из корзины вместе со всем, что уехало туда с ней.
 *
 * Триггеры владения здесь не мешают: на папках они висят
 * ON UPDATE OF parent_id, owner_id, на заметках — OF folder_id, owner_id,
 * а снятие is_archived не трогает ни одну из этих колонок. Единственная
 * правка, которая их задевает, — обнуление parent_id у корня, и null
 * триггер пропускает первой же строкой.
 */
export async function restoreFolder(
  ownerId: string,
  folderId: string,
): Promise<Folder> {
  const parent = alias(folders, "parent_folder");

  const [root] = await db
    .select({ parentId: folders.parentId, parentArchived: parent.isArchived })
    .from(folders)
    .leftJoin(parent, eq(parent.id, folders.parentId))
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.ownerId, ownerId),
        eq(folders.isArchived, true),
      ),
    );

  if (!root) throw notFound();

  const uplift = root.parentId !== null && root.parentArchived === true;
  const position = uplift ? await nextFolderPosition(ownerId, null) : undefined;

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      with recursive ${groupFolders(ownerId, folderId)},
      restored_notes as (
        update notes n
        set is_archived = false, archived_at = null, updated_at = now()
        from group_folders gf
        where n.folder_id = gf.id
          and n.owner_id = ${ownerId}
          and n.is_archived = true
          and n.archived_at = gf.archived_at
        returning n.id
      )
      update folders
      set is_archived = false, archived_at = null, updated_at = now()
      where owner_id = ${ownerId}
        and id in (select id from group_folders)
    `);

    // Родитель остался в корзине — папка всплывает в корень. Делается
    // отдельным запросом после снятия флагов: до него строка ещё архивная,
    // и порядок «сначала оживить, потом переставить» держит инвариант
    // «живая папка не лежит в удалённой» без единого промежуточного
    // состояния наружу — транзакция одна.
    if (uplift) {
      await tx
        .update(folders)
        .set({ parentId: null, position, updatedAt: new Date() })
        .where(and(eq(folders.id, folderId), eq(folders.ownerId, ownerId)));
    }

    const [folder] = await tx
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.ownerId, ownerId)));

    if (!folder) throw notFound();
    return folder;
  });
}

/**
 * Удалить заметку из корзины насовсем.
 *
 * Каскад по note_id уносит вложения, связи и векторы; байты вложений
 * приходится убирать самим — на диске каскадов нет.
 */
export async function purgeNote(ownerId: string, noteId: string): Promise<void> {
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, true),
      ),
    );

  if (!note) throw notFound();

  const files = await db
    .select({ id: attachments.id, mimeType: attachments.mimeType })
    .from(attachments)
    .where(eq(attachments.noteId, noteId));

  await db
    .delete(notes)
    .where(
      and(
        eq(notes.id, noteId),
        eq(notes.ownerId, ownerId),
        eq(notes.isArchived, true),
      ),
    );

  await deleteFiles(ownerId, files);
}

/**
 * Удалить папку из корзины насовсем — вместе с группой, но только с ней.
 *
 * Главная тонкость здесь — чужие дети. У folders.parent_id стоит
 * on delete cascade, поэтому удаление папки утащило бы за собой и ту
 * вложенную папку, которую отправили в корзину раньше и отдельно, а она
 * лежит в списке своей строкой и своего решения ещё не дождалась.
 * Поэтому перед удалением такие ветки отцепляются в корень.
 *
 * С заметками этой заботы нет: у notes.folder_id стоит on delete set null,
 * чужая заметка просто станет вершиной собственной группы.
 *
 * Отдельными запросами в транзакции, а не одним data-modifying CTE:
 * подзапросы в CTE видят общий снимок и не видят правок друг друга, так что
 * «отцепить, потом удалить» внутри одного оператора зависело бы от того,
 * когда сработают RI-триггеры. Транзакция дороже на два round-trip
 * и не зависит ни от чего.
 */
export async function purgeFolder(
  ownerId: string,
  folderId: string,
): Promise<void> {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.ownerId, ownerId),
        eq(folders.isArchived, true),
      ),
    );

  if (!folder) throw notFound();

  const files = await db.execute<DoomedFile>(sql`
    with recursive ${groupFolders(ownerId, folderId)}
    select a.id, a.mime_type as "mimeType"
    from attachments a
    join notes n on n.id = a.note_id
    join group_folders gf on n.folder_id = gf.id
    where n.owner_id = ${ownerId}
      and n.is_archived = true
      and n.archived_at = gf.archived_at
  `);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      with recursive ${groupFolders(ownerId, folderId)}
      update folders child
      set parent_id = null
      where child.owner_id = ${ownerId}
        and child.parent_id in (select id from group_folders)
        and child.id not in (select id from group_folders)
    `);

    await tx.execute(sql`
      with recursive ${groupFolders(ownerId, folderId)}
      delete from notes n
      using group_folders gf
      where n.folder_id = gf.id
        and n.owner_id = ${ownerId}
        and n.is_archived = true
        and n.archived_at = gf.archived_at
    `);

    await tx.execute(sql`
      with recursive ${groupFolders(ownerId, folderId)}
      delete from folders
      where owner_id = ${ownerId}
        and id in (select id from group_folders)
    `);
  });

  await deleteFiles(ownerId, files.rows);
}

/**
 * Удалить из корзины всё.
 *
 * Групп здесь считать не нужно: уезжает вся корзина целиком, и отцеплять
 * ветки не от чего. Живая папка с архивным родителем невозможна —
 * restoreFolder поднимает такую в корень.
 */
export async function emptyTrash(ownerId: string): Promise<void> {
  await purgeArchived(ownerId, null);
}

/**
 * Удалить просроченное.
 *
 * Строки рассматриваются независимо друг от друга, и это безопасно:
 * разный archived_at у папки и заметки внутри означает, что они и так
 * из разных групп. Заметка из удалённой по сроку папки не пропадёт —
 * on delete set null поднимет её в корень корзины, где она дождётся
 * своего срока.
 */
export async function purgeExpired(ownerId: string): Promise<void> {
  await purgeArchived(ownerId, TRASH_RETENTION_DAYS);
}

/**
 * Условие «эту строку пора удалить» для конкретной таблицы запроса.
 *
 * Принимает имя или псевдоним таблицы, потому что в трёх запросах ниже
 * колонка называется по-разному: notes, folders и child. Готовым куском
 * SQL условие не передать — без квалификации оно стало бы неоднозначным
 * там, где в запросе участвуют обе таблицы.
 *
 * retention = null означает «вся корзина», и тогда условия нет вовсе.
 */
function expiredIn(table: string, retention: number | null): SQL {
  if (retention === null) return sql`true`;

  return sql`${sql.raw(table)}.archived_at < now() - ${`${retention} days`}::interval`;
}

/**
 * Общая часть emptyTrash и purgeExpired: снести архивные строки владельца,
 * попадающие под условие.
 *
 * Отцепление детей нужно и здесь, по той же причине, что в purgeFolder:
 * срок у вложенной папки может ещё не выйти, а у родителя уже вышел.
 */
async function purgeArchived(
  ownerId: string,
  retention: number | null,
): Promise<void> {
  const files = await db.execute<DoomedFile>(sql`
    select a.id, a.mime_type as "mimeType"
    from attachments a
    join notes n on n.id = a.note_id
    where n.owner_id = ${ownerId}
      and n.is_archived = true
      and ${expiredIn("n", retention)}
  `);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update folders as child
      set parent_id = null
      where child.owner_id = ${ownerId}
        and child.parent_id in (
          select doomed.id
          from folders as doomed
          where doomed.owner_id = ${ownerId}
            and doomed.is_archived = true
            and ${expiredIn("doomed", retention)}
        )
        and not (child.is_archived = true and ${expiredIn("child", retention)})
    `);

    await tx.execute(sql`
      delete from notes
      where owner_id = ${ownerId}
        and is_archived = true
        and ${expiredIn("notes", retention)}
    `);

    await tx.execute(sql`
      delete from folders
      where owner_id = ${ownerId}
        and is_archived = true
        and ${expiredIn("folders", retention)}
    `);
  });

  await deleteFiles(ownerId, files.rows);
}
