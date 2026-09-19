"use client";

import { FileTextIcon, FolderIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import type { TrashItem } from "@/domain/trash";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Список удалённого.
 *
 * Строки приходят пропсами с сервера; после любого действия страница
 * обновляется через router.refresh(), а не правит список у себя. Второго
 * источника правды здесь нет по той же причине, что и в дереве: список
 * серверный, и клиентская копия разошлась бы с ним при первой же ошибке.
 */
export function TrashList({
  items,
  retentionDays,
}: {
  items: TrashItem[];
  retentionDays: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  /** Что подтверждаем: одну строку или всю корзину. */
  const [purging, setPurging] = useState<TrashItem | "all" | null>(null);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      startTransition(() => router.refresh());
      return true;
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "Что-то пошло не так.");
      return false;
    }
  }

  async function restore(item: TrashItem) {
    const ok = await run(() =>
      apiFetch(`/api/trash/${apiKind(item)}/${item.id}/restore`, { method: "POST" }),
    );

    if (!ok) return;

    toast.success(
      item.kind === "folder" ? "Папка восстановлена" : "Заметка восстановлена",
      item.kind === "note"
        ? {
            action: {
              label: "Открыть",
              onClick: () => router.push(`/n/${item.id}`),
            },
          }
        : undefined,
    );
  }

  async function confirmPurge() {
    const target = purging;
    if (!target) return;
    setPurging(null);

    if (target === "all") {
      const ok = await run(() => apiFetch("/api/trash", { method: "DELETE" }));
      if (ok) toast.success("Корзина очищена");
      return;
    }

    const ok = await run(() =>
      apiFetch(`/api/trash/${apiKind(target)}/${target.id}`, { method: "DELETE" }),
    );
    if (ok) toast.success("Удалено навсегда");
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold">Корзина</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Удалённое хранится {retentionDays} дней, потом исчезает без
            возможности восстановить.
          </p>
        </div>

        {items.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setPurging("all")}>
            <Trash2Icon />
            Очистить корзину
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Здесь пусто. Всё, что удаляется из дерева, сначала попадает сюда.
        </p>
      ) : (
        <ul className="mt-6 grid gap-2">
          {items.map((item) => (
            <li
              key={`${item.kind}:${item.id}`}
              // На узком экране кнопки переезжают под название: три колонки
              // в 390 пикселей не помещаются, а обрезать название нельзя —
              // по нему и опознают, что восстанавливают.
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5"
            >
              <span className="text-muted-foreground [&_svg]:size-4">
                {item.kind === "folder" ? <FolderIcon /> : <FileTextIcon />}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatArchivedAt(item.archivedAt)}
                  {item.kind === "folder" && `, ${formatNoteCount(item.noteCount ?? 0)}`}
                </p>
              </div>

              <div className="ml-auto flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" onClick={() => restore(item)}>
                  <RotateCcwIcon />
                  Восстановить
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setPurging(item)}
                  aria-label={`Удалить навсегда «${item.title}»`}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={purging !== null}
        onOpenChange={(open) => {
          if (!open) setPurging(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{purgeTitle(purging)}</AlertDialogTitle>
            <AlertDialogDescription>{purgeDescription(purging)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmPurge}>
              Удалить навсегда
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Сегмент адреса: в API множественное число, в модели — единственное. */
function apiKind(item: TrashItem): string {
  return item.kind === "folder" ? "folders" : "notes";
}

function purgeTitle(target: TrashItem | "all" | null): string {
  if (target === "all") return "Очистить корзину?";
  if (target === null) return "";
  return `Удалить ${target.kind === "folder" ? "папку" : "заметку"} «${target.title}» навсегда?`;
}

function purgeDescription(target: TrashItem | "all" | null): string {
  if (target === "all") {
    return "Всё содержимое корзины исчезнет вместе с вложенными файлами. Отменить это будет нельзя.";
  }

  if (target === null) return "";

  if (target.kind === "folder") {
    const count = target.noteCount ?? 0;
    return count > 0
      ? `Папка и ${formatNoteCount(count)} внутри исчезнут вместе с вложенными файлами. Отменить это будет нельзя.`
      : "Папка исчезнет окончательно. Отменить это будет нельзя.";
  }

  return "Заметка исчезнет вместе с вложенными файлами. Отменить это будет нельзя.";
}

/**
 * «1 заметка», «2 заметки», «5 заметок».
 *
 * Intl.PluralRules знает русские правила и не требует таблицы исключений
 * на 11–14, где наивное «остаток от деления» ошибается.
 */
const PLURAL_RULES = new Intl.PluralRules("ru-RU");

const NOTE_FORMS: Record<string, string> = {
  one: "заметка",
  few: "заметки",
  many: "заметок",
  other: "заметки",
};

function formatNoteCount(count: number): string {
  return `${count} ${NOTE_FORMS[PLURAL_RULES.select(count)]}`;
}

function formatArchivedAt(date: Date): string {
  return `Удалено ${date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}`;
}
