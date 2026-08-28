import { FileTextIcon, FolderIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type { TreeNode } from "@/db/queries/tree";
import { cn } from "@/lib/utils";

/**
 * Дерево только для чтения: страница папки.
 *
 * Компонент ничего не решает про доступ — он показывает ровно те узлы,
 * что ему передали. Фильтрация живёт в loadPublicSubtree.
 */
export function StaticTree({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
  if (nodes.length === 0) {
    return depth === 0 ? (
      <p className="text-sm text-muted-foreground">
        Здесь пока нет опубликованных заметок.
      </p>
    ) : null;
  }

  return (
    <ul className={cn("flex flex-col gap-0.5", depth > 0 && "ml-4 border-l pl-3")}>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <li key={node.id}>
            <Link
              href={`/f/${node.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              {node.title}
            </Link>
            <StaticTree nodes={node.children} depth={depth + 1} />
          </li>
        ) : (
          <li key={node.id}>
            <Link
              href={`/n/${node.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
            >
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{node.title}</span>
              {node.visibility === "private" && (
                <Badge variant="secondary" className="shrink-0">
                  private
                </Badge>
              )}
            </Link>
          </li>
        ),
      )}
    </ul>
  );
}
