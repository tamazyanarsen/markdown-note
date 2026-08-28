"use client";

import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  ChevronRightIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import type { TreeNode } from "@/db/queries/tree";
import { ApiError, apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

import { locate, resolveMove, type DropTarget } from "./drop-target";

interface TreeViewProps {
  tree: TreeNode[];
  /** Заметка, открытая сейчас — подсвечивается в дереве. */
  activeNoteId?: string;
}

/** Что именно создаём и где — состояние диалога с названием. */
interface CreateIntent {
  kind: "folder" | "note";
  parentId: string | null;
  /** Куда кладём: для заголовка диалога. */
  parentTitle: string;
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
  const { setOpenMobile } = useSidebar();
  const [, startTransition] = useTransition();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreateIntent | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [deleting, setDeleting] = useState<TreeNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(collectFolderIds(tree)),
  );

  /**
   * Мышь и палец разведены по разным сенсорам намеренно.
   *
   * Мышь: 5 пикселей до старта, иначе обычный клик по ссылке превращался бы
   * в перетаскивание.
   *
   * Палец: та же дистанционная активация сделала бы дерево непрокручиваемым —
   * вертикальный свайп уходил бы в drag вместо скролла. Поэтому здесь
   * удержание: 250 мс на месте (допуск 5px на дрожание пальца). Короткий тап
   * остаётся переходом по ссылке, свайп — прокруткой.
   */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      startTransition(() => router.refresh());
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "Что-то пошло не так.");
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

  // Поле диалога живёт здесь, а не внутри него: так его чистит обработчик
  // открытия, и не нужен эффект, сбрасывающий состояние после рендера.
  function openCreate(intent: CreateIntent) {
    setNewTitle("");
    setCreating(intent);
  }

  async function create(title: string) {
    if (!creating) return;
    const { kind, parentId } = creating;
    setCreating(null);

    await run(() =>
      kind === "folder"
        ? apiFetch("/api/folders", { method: "POST", json: { title, parentId } })
        : apiFetch("/api/notes", { method: "POST", json: { title, folderId: parentId } }),
    );
  }

  async function confirmDelete() {
    if (!deleting) return;
    const node = deleting;
    setDeleting(null);

    await run(() =>
      apiFetch(`/api/${node.kind === "folder" ? "folders" : "notes"}/${node.id}`, {
        method: "DELETE",
      }),
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
      <SidebarGroup className="h-full min-h-0 gap-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() =>
              openCreate({ kind: "folder", parentId: null, parentTitle: "корне" })
            }
          >
            <FolderPlusIcon />
            Папка
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() =>
              openCreate({ kind: "note", parentId: null, parentTitle: "корне" })
            }
          >
            <FilePlusIcon />
            Заметка
          </Button>
        </div>

        <RootDropZone active={draggingId !== null} />

        {/* min-h-0 flex-1 обязательны: без них список не получает
            ограниченную высоту и overflow-y-auto не срабатывает.
            Клик по ссылке закрывает выехавшую панель на телефоне — иначе
            она перекрыла бы страницу, на которую только что перешли.
            Кнопки ссылками не являются и панель не закрывают. */}
        <SidebarMenu
          className="min-h-0 flex-1 gap-0.5 overflow-y-auto"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setOpenMobile(false);
          }}
        >
          {tree.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">Пока пусто.</li>
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
              onCreate={openCreate}
              onDelete={setDeleting}
              run={run}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      <DragOverlay dropAnimation={null}>
        {draggedNode && (
          <Badge variant="outline" className="h-7 bg-popover px-2 shadow-lg">
            {draggedNode.kind === "folder" ? <FolderIcon /> : <FileTextIcon />}
            {draggedNode.title}
          </Badge>
        )}
      </DragOverlay>

      <CreateDialog
        intent={creating}
        title={newTitle}
        onTitleChange={setNewTitle}
        onCancel={() => setCreating(null)}
        onSubmit={create}
      />

      <DeleteDialog
        node={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
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
      className={cn(
        "rounded-md border border-dashed px-2 py-1.5 text-center text-xs transition-all",
        active ? "opacity-100" : "pointer-events-none opacity-0",
        isOver
          ? "border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground",
      )}
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
  onCreate: (intent: CreateIntent) => void;
  onDelete: (node: TreeNode) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}

function TreeItem({
  node,
  depth,
  expanded,
  onToggle,
  activeNoteId,
  draggingId,
  onCreate,
  onDelete,
  run,
}: TreeItemProps) {
  const [renaming, setRenaming] = useState(false);

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
  const Icon = isFolder ? (isOpen ? FolderOpenIcon : FolderIcon) : FileTextIcon;

  return (
    <SidebarMenuItem className="relative">
      {/* Тонкая полоса сверху: бросок сюда означает «поставить перед». */}
      {draggingId && (
        <div
          ref={setBeforeRef}
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-2 -translate-y-1 rounded",
            isOverBefore && "bg-sidebar-ring",
          )}
        />
      )}

      <div
        ref={isFolder ? setIntoRef : undefined}
        style={{ paddingLeft: depth * 12 }}
        className={cn(
          "group/row flex items-center gap-0.5 rounded-md transition-colors",
          isBeingDragged && "opacity-40",
          isFolder && isOverInto && "bg-sidebar-accent ring-1 ring-sidebar-ring",
        )}
      >
        {isFolder ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onToggle(node.id)}
            aria-label={isOpen ? "Свернуть" : "Развернуть"}
            aria-expanded={isOpen}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronRightIcon className={cn("transition-transform", isOpen && "rotate-90")} />
          </Button>
        ) : (
          // Пустышка вместо стрелки: без неё заметки и папки одного уровня
          // разъезжаются по горизонтали.
          <span aria-hidden className="w-6 shrink-0" />
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
            {/* Ручка перетаскивания — обёртка вокруг ссылки, а не сама ссылка:
                dnd-kit ставит на элемент role="button", и на <a> это сломало бы
                и семантику, и переход по клику. */}
            <span
              ref={setDragRef}
              {...dragListeners}
              {...dragAttributes}
              className="min-w-0 flex-1 cursor-grab active:cursor-grabbing"
            >
              <SidebarMenuButton asChild isActive={node.id === activeNoteId}>
                <Link href={isFolder ? `/f/${node.id}` : `/n/${node.id}`}>
                  <Icon className="text-muted-foreground" />
                  <span className={cn(isFolder && "font-medium")}>{node.title}</span>
                </Link>
              </SidebarMenuButton>
            </span>

            {node.kind === "note" && node.visibility === "public" && (
              <Badge
                variant="outline"
                title="Заметка опубликована"
                className="shrink-0 border-success/40 text-success"
              >
                public
              </Badge>
            )}

            <RowMenu
              node={node}
              onCreate={onCreate}
              onRename={() => setRenaming(true)}
              onDelete={() => onDelete(node)}
            />
          </>
        )}
      </div>

      {isOpen && node.kind === "folder" && node.children.length > 0 && (
        <SidebarMenu className="gap-0.5">
          {node.children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              activeNoteId={activeNoteId}
              draggingId={draggingId}
              onCreate={onCreate}
              onDelete={onDelete}
              run={run}
            />
          ))}
        </SidebarMenu>
      )}
    </SidebarMenuItem>
  );
}

/**
 * Действия над строкой одним меню.
 *
 * Раньше это был ряд кнопок, спрятанный под group-hover. На тач-экране ховера
 * нет, поэтому кнопки приходилось показывать всегда — и они съедали ширину
 * у названия. Одна кнопка «…» помещается везде.
 */
function RowMenu({
  node,
  onCreate,
  onRename,
  onDelete,
}: {
  node: TreeNode;
  onCreate: (intent: CreateIntent) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const isFolder = node.kind === "folder";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Действия: ${node.title}`}
          // Под мышью кнопка появляется по наведению на строку, на тач-экране
          // видна всегда. Открытое меню держит кнопку видимой в обоих случаях.
          className="shrink-0 text-muted-foreground transition-opacity hoverable:opacity-0 hoverable:group-hover/row:opacity-100 hoverable:aria-expanded:opacity-100"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>

      {/* w-* перебивает ширину по триггеру: триггер здесь — иконка в 24px. */}
      <DropdownMenuContent align="end" className="w-48 min-w-48">
        {isFolder && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                onCreate({
                  kind: "folder",
                  parentId: node.id,
                  parentTitle: `«${node.title}»`,
                })
              }
            >
              <FolderPlusIcon />
              Новая папка
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                onCreate({
                  kind: "note",
                  parentId: node.id,
                  parentTitle: `«${node.title}»`,
                })
              }
            >
              <FilePlusIcon />
              Новая заметка
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem onSelect={onRename}>
          <PencilIcon />
          Переименовать
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Удалить
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Диалог с названием вместо window.prompt. */
function CreateDialog({
  intent,
  title,
  onTitleChange,
  onCancel,
  onSubmit,
}: {
  intent: CreateIntent | null;
  title: string;
  onTitleChange: (title: string) => void;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const isFolder = intent?.kind === "folder";

  return (
    <Dialog
      open={intent !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const value = title.trim();
            if (value) onSubmit(value);
          }}
        >
          <DialogHeader>
            <DialogTitle>{isFolder ? "Новая папка" : "Новая заметка"}</DialogTitle>
            <DialogDescription>
              {isFolder ? "Папка" : "Заметка"} появится в {intent?.parentTitle}.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="new-node-title">Название</Label>
            <Input
              id="new-node-title"
              autoFocus
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={isFolder ? "Например, «Рабочее»" : "Например, «Черновик»"}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Отмена
            </Button>
            <Button type="submit" disabled={title.trim() === ""}>
              Создать
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Подтверждение удаления вместо window.confirm. */
function DeleteDialog({
  node,
  onCancel,
  onConfirm,
}: {
  node: TreeNode | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isFolder = node?.kind === "folder";

  return (
    <AlertDialog
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isFolder ? "Удалить папку" : "Удалить заметку"} «{node?.title}»?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isFolder
              ? "Вместе с папкой удалится всё её содержимое."
              : "Заметка и её содержимое будут удалены."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Удалить
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
      className="min-w-0 flex-1 py-0.5"
      onSubmit={(event) => {
        event.preventDefault();
        const title = value.trim();
        if (title && title !== initialValue) onSubmit(title);
        else onCancel();
      }}
    >
      <Input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        className="h-7 text-sm"
      />
    </form>
  );
}

function collectFolderIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node.id, ...collectFolderIds(node.children)] : [],
  );
}
