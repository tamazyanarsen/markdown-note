"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { TreeNode } from "@/db/queries/tree";
import { ApiError, apiFetch } from "@/lib/api-client";

import { locate, resolveMove, type DropTarget } from "./drop-target";

interface TreeViewProps {
  tree: TreeNode[];
  /** Заметка, открытая сейчас — подсвечивается в дереве. */
  activeNoteId?: string;
}

/** id droppable-зоны кодирует, что именно означает бросок в это место. */
const dropId = (target: DropTarget) =>
  target.type === "into" ? `into:${target.folderId ?? "root"}` : `before:${target.nodeId}`;

function parseDropId(id: string): DropTarget | null {
  const [type, value] = id.split(":");
  if (type === "into") return { type: "into", folderId: value === "root" ? null : value };
  if (type === "before") return { type: "before", nodeId: value };
  return null;
}

export function TreeView({ tree, activeNoteId }: TreeViewProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(collectFolderIds(tree)),
  );

  // 5 пикселей до старта перетаскивания: иначе обычный клик по ссылке
  // превращался бы в drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Что-то пошло не так.");
    }
  }

  const toggle = (folderId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  function onDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
  }

  async function onDragEnd(event: DragEndEvent) {
    setDraggingId(null);

    const { active, over } = event;
    if (!over) return;

    const target = parseDropId(String(over.id));
    if (!target) return;

    const draggedId = String(active.id);
    const move = resolveMove(tree, draggedId, target);
    if (!move) return;

    const dragged = locate(tree, draggedId);
    if (!dragged) return;

    const endpoint = dragged.node.kind === "folder" ? "folders" : "notes";
    await run(() =>
      apiFetch(`/api/${endpoint}/${draggedId}/move`, { method: "POST", json: move }),
    );
  }

  const draggedNode = draggingId ? locate(tree, draggingId)?.node : null;

  return (
    // Явный id обязателен: без него dnd-kit нумерует служебные
    // aria-describedby на сервере и на клиенте независимо, и React
    // ругается на несовпадение при гидрации.
    <DndContext
      id="tree"
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="flex h-full flex-col gap-2">
        <NodeActions
          label="В корне"
          onCreateFolder={(title) =>
            run(() =>
              apiFetch("/api/folders", { method: "POST", json: { title, parentId: null } }),
            )
          }
          onCreateNote={(title) =>
            run(() =>
              apiFetch("/api/notes", { method: "POST", json: { title, folderId: null } }),
            )
          }
        />

        {error && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <RootDropZone active={draggingId !== null} />

        <ul className="flex flex-col gap-0.5 overflow-y-auto text-sm">
          {tree.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted">Пока пусто.</li>
          )}
          {tree.map((node) => (
            <TreeItem
              key={node.id}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              activeNoteId={activeNoteId}
              draggingId={draggingId}
              run={run}
            />
          ))}
        </ul>
      </div>

      <DragOverlay dropAnimation={null}>
        {draggedNode && (
          <span className="rounded-md border border-border bg-background px-2 py-1 text-sm shadow-lg">
            {draggedNode.title}
          </span>
        )}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Зона «перенести в корень».
 *
 * Она присутствует в разметке всегда и лишь меняет прозрачность: если
 * показывать её только во время перетаскивания, дерево прыгает вниз ровно
 * в тот момент, когда пользователь целится курсором, и папка уезжает
 * из-под указателя.
 */
function RootDropZone({ active }: { active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: dropId({ type: "into", folderId: null }),
  });

  return (
    <div
      ref={setNodeRef}
      aria-hidden={!active}
      className={`rounded-md border border-dashed px-2 py-1.5 text-center text-xs transition-all ${
        active ? "opacity-100" : "pointer-events-none opacity-0"
      } ${isOver ? "border-foreground bg-surface" : "border-border text-muted"}`}
    >
      Перенести в корень
    </div>
  );
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (folderId: string) => void;
  activeNoteId?: string;
  draggingId: string | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

function TreeItem({
  node,
  depth,
  expanded,
  onToggle,
  activeNoteId,
  draggingId,
  run,
}: TreeItemProps) {
  const [renaming, setRenaming] = useState(false);
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  const {
    setNodeRef: setDragRef,
    listeners: dragListeners,
    attributes: dragAttributes,
  } = useDraggable({ id: node.id });

  const { setNodeRef: setBeforeRef, isOver: isOverBefore } = useDroppable({
    id: dropId({ type: "before", nodeId: node.id }),
  });

  const { setNodeRef: setIntoRef, isOver: isOverInto } = useDroppable({
    id: dropId({ type: "into", folderId: node.kind === "folder" ? node.id : null }),
    disabled: node.kind !== "folder",
  });

  const isBeingDragged = draggingId === node.id;
  const isFolder = node.kind === "folder";
  const isOpen = isFolder && expanded.has(node.id);

  return (
    <li className="relative">
      {/* Тонкая полоса сверху: бросок сюда означает «поставить перед». */}
      {draggingId && (
        <div
          ref={setBeforeRef}
          className={`absolute inset-x-0 top-0 z-10 h-2 -translate-y-1 rounded ${
            isOverBefore ? "bg-foreground/60" : ""
          }`}
        />
      )}

      <div
        ref={isFolder ? setIntoRef : undefined}
        className={`group flex items-center gap-1 rounded-md py-1 pr-1 transition-colors ${
          isBeingDragged ? "opacity-40" : ""
        } ${
          isFolder && isOverInto
            ? "bg-foreground/10 ring-1 ring-foreground/30"
            : "hover:bg-surface"
        } ${node.id === activeNoteId ? "bg-surface font-medium" : ""}`}
        style={indent}
      >
        {isFolder && (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            className="w-4 shrink-0 cursor-pointer text-muted"
            aria-label={isOpen ? "Свернуть" : "Развернуть"}
          >
            {isOpen ? "▾" : "▸"}
          </button>
        )}

        {renaming ? (
          <RenameField
            initialValue={node.title}
            onCancel={() => setRenaming(false)}
            onSubmit={async (title) => {
              setRenaming(false);
              await run(() =>
                apiFetch(`/api/${isFolder ? "folders" : "notes"}/${node.id}`, {
                  method: "PATCH",
                  json: { title },
                }),
              );
            }}
          />
        ) : (
          <>
            <span
              ref={setDragRef}
              {...dragListeners}
              {...dragAttributes}
              className="min-w-0 flex-1 cursor-grab active:cursor-grabbing"
            >
              <Link
                href={isFolder ? `/f/${node.id}` : `/n/${node.id}`}
                className={`block truncate ${isFolder ? "font-medium" : ""}`}
              >
                {node.title}
              </Link>
            </span>

            {node.kind === "note" && node.visibility === "public" && (
              <span
                title="Заметка опубликована"
                className="shrink-0 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400"
              >
                public
              </span>
            )}

            {isFolder && (
              <NodeActions
                compact
                label={node.title}
                onCreateFolder={(title) =>
                  run(() =>
                    apiFetch("/api/folders", {
                      method: "POST",
                      json: { title, parentId: node.id },
                    }),
                  )
                }
                onCreateNote={(title) =>
                  run(() =>
                    apiFetch("/api/notes", {
                      method: "POST",
                      json: { title, folderId: node.id },
                    }),
                  )
                }
              />
            )}

            <RowActions
              onRename={() => setRenaming(true)}
              onDelete={() =>
                run(() =>
                  apiFetch(`/api/${isFolder ? "folders" : "notes"}/${node.id}`, {
                    method: "DELETE",
                  }),
                )
              }
              deleteConfirm={
                isFolder
                  ? `Удалить папку «${node.title}» вместе со всем содержимым?`
                  : `Удалить заметку «${node.title}»?`
              }
            />
          </>
        )}
      </div>

      {isOpen && node.kind === "folder" && node.children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              activeNoteId={activeNoteId}
              draggingId={draggingId}
              run={run}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function RowActions({
  onRename,
  onDelete,
  deleteConfirm,
}: {
  onRename: () => void;
  onDelete: () => void;
  deleteConfirm: string;
}) {
  return (
    <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <button
        type="button"
        onClick={onRename}
        title="Переименовать"
        className="cursor-pointer px-1 text-xs text-muted hover:text-foreground"
      >
        ✎
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.confirm(deleteConfirm)) onDelete();
        }}
        title="Удалить"
        className="cursor-pointer px-1 text-xs text-muted hover:text-red-600"
      >
        ✕
      </button>
    </span>
  );
}

function NodeActions({
  label,
  compact,
  onCreateFolder,
  onCreateNote,
}: {
  label: string;
  compact?: boolean;
  onCreateFolder: (title: string) => void;
  onCreateNote: (title: string) => void;
}) {
  const ask = (kind: "папки" | "заметки", create: (title: string) => void) => {
    const title = window.prompt(`Название новой ${kind} в «${label}»`);
    if (title?.trim()) create(title.trim());
  };

  if (compact) {
    return (
      <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => ask("папки", onCreateFolder)}
          title="Новая папка внутри"
          className="cursor-pointer px-1 text-xs text-muted hover:text-foreground"
        >
          +📁
        </button>
        <button
          type="button"
          onClick={() => ask("заметки", onCreateNote)}
          title="Новая заметка внутри"
          className="cursor-pointer px-1 text-xs text-muted hover:text-foreground"
        >
          +📄
        </button>
      </span>
    );
  }

  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => ask("папки", onCreateFolder)}
        className="flex-1 cursor-pointer rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-surface"
      >
        + Папка
      </button>
      <button
        type="button"
        onClick={() => ask("заметки", onCreateNote)}
        className="flex-1 cursor-pointer rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-surface"
      >
        + Заметка
      </button>
    </div>
  );
}

function RenameField({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <form
      className="flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const title = value.trim();
        if (title && title !== initialValue) onSubmit(title);
        else onCancel();
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        className="w-full rounded border border-border bg-background px-1 py-0.5 text-sm outline-none"
      />
    </form>
  );
}

function collectFolderIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node.id, ...collectFolderIds(node.children)] : [],
  );
}
