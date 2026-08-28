import Link from "next/link";

import type { TreeNode } from "@/db/queries/tree";

/**
 * Дерево только для чтения: страница папки.
 *
 * Компонент ничего не решает про доступ — он показывает ровно те узлы,
 * что ему передали. Фильтрация живёт в loadPublicSubtree.
 */
export function StaticTree({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
  if (nodes.length === 0) {
    return depth === 0 ? (
      <p className="text-sm text-muted">Здесь пока нет опубликованных заметок.</p>
    ) : null;
  }

  return (
    <ul className={depth === 0 ? "flex flex-col gap-1" : "ml-4 flex flex-col gap-1 border-l border-border pl-3"}>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={node.id}>
            <Link
              href={`/f/${node.id}`}
              className="font-medium hover:underline underline-offset-4"
            >
              {node.title}
            </Link>
            <StaticTree nodes={node.children} depth={depth + 1} />
          </li>
        ) : (
          <li key={node.id} className="flex items-baseline gap-2">
            <Link href={`/n/${node.id}`} className="hover:underline underline-offset-4">
              {node.title}
            </Link>
            {node.visibility === "private" && (
              <span className="rounded bg-surface px-1 text-[10px] text-muted">private</span>
            )}
          </li>
        ),
      )}
    </ul>
  );
}
