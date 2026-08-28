import type { TreeNode } from "@/db/queries/tree";
import { positionBetween } from "@/lib/position";

/**
 * Куда именно можно бросить перетаскиваемый узел.
 *
 *  - into: внутрь папки, в конец списка;
 *  - before: перед конкретным узлом того же вида и того же родителя.
 */
export type DropTarget =
  | { type: "into"; folderId: string | null }
  | { type: "before"; nodeId: string };

export interface MoveRequest {
  targetFolderId: string | null;
  position?: string;
}

interface Located {
  node: TreeNode;
  parentId: string | null;
  siblings: TreeNode[];
}

/** Находит узел, его родителя и соседей того же вида. */
export function locate(
  tree: TreeNode[],
  nodeId: string,
  parentId: string | null = null,
): Located | null {
  for (const node of tree) {
    if (node.id === nodeId) {
      return {
        node,
        parentId,
        siblings: tree.filter((sibling) => sibling.kind === node.kind),
      };
    }

    if (node.kind === "folder") {
      const found = locate(node.children, nodeId, node.id);
      if (found) return found;
    }
  }

  return null;
}

/** Является ли candidate потомком folderId — проверка цикла на клиенте. */
export function isDescendant(
  tree: TreeNode[],
  folderId: string,
  candidateId: string,
): boolean {
  const located = locate(tree, folderId);
  if (!located || located.node.kind !== "folder") return false;

  const walk = (nodes: TreeNode[]): boolean =>
    nodes.some(
      (node) =>
        node.id === candidateId || (node.kind === "folder" && walk(node.children)),
    );

  return walk(located.node.children);
}

/**
 * Превращает «бросили сюда» в тело запроса /move.
 *
 * Возвращает null, если перемещение бессмысленно или запрещено: бросок
 * на самого себя, папка внутрь своего потомка, заметка перед папкой.
 * Сервер проверяет то же самое повторно — здесь это только для того,
 * чтобы не гонять заведомо неудачный запрос и не мигать ошибкой.
 */
export function resolveMove(
  tree: TreeNode[],
  draggedId: string,
  target: DropTarget,
): MoveRequest | null {
  const dragged = locate(tree, draggedId);
  if (!dragged) return null;

  if (target.type === "into") {
    if (target.folderId === draggedId) return null;
    if (target.folderId === dragged.parentId) return null;
    if (
      dragged.node.kind === "folder" &&
      target.folderId &&
      isDescendant(tree, draggedId, target.folderId)
    ) {
      return null;
    }

    // Позицию не передаём: сервер положит в конец списка.
    return { targetFolderId: target.folderId };
  }

  const anchor = locate(tree, target.nodeId);
  if (!anchor || anchor.node.id === draggedId) return null;

  // Папки и заметки сортируются раздельно, поэтому «перед» имеет смысл
  // только внутри своей группы.
  if (anchor.node.kind !== dragged.node.kind) return null;

  if (
    dragged.node.kind === "folder" &&
    anchor.parentId &&
    isDescendant(tree, draggedId, anchor.parentId)
  ) {
    return null;
  }

  const index = anchor.siblings.findIndex((sibling) => sibling.id === anchor.node.id);
  const previous = index > 0 ? anchor.siblings[index - 1] : null;

  // Уже стоит ровно там — двигать нечего.
  if (previous?.id === draggedId && dragged.parentId === anchor.parentId) return null;

  const { position } = positionBetween(
    previous?.position ?? null,
    anchor.node.position,
  );

  return { targetFolderId: anchor.parentId, position };
}
