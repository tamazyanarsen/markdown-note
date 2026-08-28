import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import { folders, notes, type NoteVisibility } from "../schema";

export interface FolderNode {
  kind: "folder";
  id: string;
  parentId: string | null;
  title: string;
  position: string;
  children: TreeNode[];
}

export interface NoteNode {
  kind: "note";
  id: string;
  folderId: string | null;
  title: string;
  position: string;
  /** Отсутствует в публичной проекции: гостю видимость знать незачем. */
  visibility?: NoteVisibility;
  updatedAt: Date;
}

export type TreeNode = FolderNode | NoteNode;

/**
 * Порядок внутри уровня — правило MVP из документа:
 * сначала папки, затем заметки, каждая группа по position.
 */
function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  const diff = Number(a.position) - Number(b.position);
  return diff !== 0 ? diff : a.id.localeCompare(b.id);
}

/**
 * Собирает дерево из плоских списков.
 *
 * Папка, чей parentId не встретился среди переданных папок, считается корневой:
 * так работает и полное дерево пользователя (родитель null), и публичная
 * проекция поддерева (родитель за пределами выборки).
 */
function assembleTree(
  folderRows: Array<Omit<FolderNode, "kind" | "children">>,
  noteRows: Array<Omit<NoteNode, "kind">>,
): TreeNode[] {
  const nodes = new Map<string, FolderNode>();

  for (const row of folderRows) {
    nodes.set(row.id, { kind: "folder", ...row, children: [] });
  }

  const roots: TreeNode[] = [];

  for (const folder of nodes.values()) {
    const parent = folder.parentId ? nodes.get(folder.parentId) : undefined;
    if (parent) parent.children.push(folder);
    else roots.push(folder);
  }

  for (const row of noteRows) {
    const note: NoteNode = { kind: "note", ...row };
    const parent = row.folderId ? nodes.get(row.folderId) : undefined;
    if (parent) parent.children.push(note);
    else roots.push(note);
  }

  const sortDeep = (list: TreeNode[]) => {
    list.sort(compareNodes);
    for (const node of list) {
      if (node.kind === "folder") sortDeep(node.children);
    }
  };

  sortDeep(roots);
  return roots;
}

/**
 * Полное дерево владельца.
 *
 * Рекурсивный CTE здесь не нужен: личное дерево целиком помещается
 * в два запроса, а иерархия собирается в памяти. CTE остаётся там,
 * где выборка обязана быть частичной — в публичной проекции и в проверке
 * цикла при перемещении папки.
 */
export async function loadOwnerTree(ownerId: string): Promise<TreeNode[]> {
  const [folderRows, noteRows] = await Promise.all([
    db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        title: folders.title,
        position: folders.position,
      })
      .from(folders)
      .where(and(eq(folders.ownerId, ownerId), eq(folders.isArchived, false)))
      .orderBy(asc(folders.position)),

    db
      .select({
        id: notes.id,
        folderId: notes.folderId,
        title: notes.title,
        position: notes.position,
        visibility: notes.visibility,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), eq(notes.isArchived, false)))
      .orderBy(asc(notes.position)),
  ]);

  return assembleTree(folderRows, noteRows);
}

/** Поддерево владельца, начиная с указанной папки. */
export function findSubtree(tree: TreeNode[], folderId: string): FolderNode | null {
  for (const node of tree) {
    if (node.kind !== "folder") continue;
    if (node.id === folderId) return node;
    const found = findSubtree(node.children, folderId);
    if (found) return found;
  }
  return null;
}

type PublicRow = {
  id: string;
  parent_id: string | null;
  title: string;
  position: string;
  kind: "folder" | "note";
  updated_at: Date | null;
};

/**
 * Публичная проекция поддерева — алгоритм из раздела «Публичное дерево папки».
 *
 * Видны: корневая папка по ссылке, все public-заметки внутри и только те
 * папки, что лежат на пути хотя бы к одной такой заметке. Private-заметки
 * не попадают в результат вообще — ни id, ни заголовок, ни время изменения.
 */
export async function loadPublicSubtree(
  folderId: string,
): Promise<FolderNode | null> {
  const result = await db.execute<PublicRow>(sql`
    with recursive folder_tree as (
      select
        f.id,
        f.parent_id,
        f.title,
        f.position,
        array[f.id] as path
      from folders f
      where f.id = ${folderId}
        and f.is_archived = false

      union all

      select
        child.id,
        child.parent_id,
        child.title,
        child.position,
        ft.path || child.id
      from folders child
      join folder_tree ft on child.parent_id = ft.id
      where child.is_archived = false
        -- Защита от цикла: в корректном дереве его нет, но рекурсия
        -- не должна зависать, если инвариант когда-нибудь нарушат.
        and not child.id = any(ft.path)
    ),
    public_notes as (
      select n.id, n.folder_id, n.title, n.position, n.updated_at
      from notes n
      join folder_tree ft on ft.id = n.folder_id
      where n.is_archived = false
        and n.visibility = 'public'
    ),
    visible_folder_ids as (
      -- Корень виден всегда, даже если публичного контента внутри нет.
      select ${folderId}::uuid as folder_id

      union

      -- Для каждой public-заметки показываем все папки на пути к ней.
      select distinct unnest(ft.path) as folder_id
      from folder_tree ft
      join public_notes pn on pn.folder_id = ft.id
    )
    select
      f.id,
      f.parent_id,
      f.title,
      f.position::text as position,
      'folder' as kind,
      null::timestamptz as updated_at
    from folder_tree f
    join visible_folder_ids v on v.folder_id = f.id

    union all

    select
      n.id,
      n.folder_id as parent_id,
      n.title,
      n.position::text as position,
      'note' as kind,
      n.updated_at
    from public_notes n
  `);

  const rows = result.rows;
  if (rows.length === 0) return null;

  const folderRows = rows
    .filter((row) => row.kind === "folder")
    .map((row) => ({
      id: row.id,
      // Родитель корня выносится за пределы выборки: иначе корень
      // не станет корнем при сборке дерева.
      parentId: row.id === folderId ? null : row.parent_id,
      title: row.title,
      position: row.position,
    }));

  const noteRows = rows
    .filter((row) => row.kind === "note")
    .map((row) => ({
      id: row.id,
      folderId: row.parent_id,
      title: row.title,
      position: row.position,
      updatedAt: row.updated_at!,
    }));

  const tree = assembleTree(folderRows, noteRows);
  const root = tree.find(
    (node): node is FolderNode => node.kind === "folder" && node.id === folderId,
  );

  return root ?? null;
}
