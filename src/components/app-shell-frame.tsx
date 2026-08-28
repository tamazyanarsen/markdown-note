"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Каркас личного кабинета.
 *
 * Широкий экран — две колонки: дерево слева, содержимое справа.
 * Узкий — дерево не помещается (288px из 360px у телефона), поэтому оно
 * уезжает в выдвижную панель, а сверху появляется полоса с кнопкой.
 *
 * Компонент клиентский только ради состояния панели. Само дерево и кнопку
 * выхода собирает серверный AppShell и передаёт сюда готовым JSX — так
 * TreeView остаётся там же, где был, и запрос к базе не переезжает в клиент.
 */
export function AppShellFrame({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    // h-dvh, а не min-h-dvh: прокрутка живёт внутри колонок, поэтому дерево
    // и шапка редактора остаются на месте, а не уезжают вверх вместе со
    // страницей. dvh вместо vh — из-за сворачивающейся адресной строки
    // мобильных браузеров.
    <div className="flex h-dvh flex-col md:flex-row">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Открыть дерево заметок"
          aria-expanded={open}
          className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-base leading-none"
        >
          ☰
        </button>
        <Link href="/" className="text-base font-semibold">
          md-note
        </Link>
      </header>

      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
        />
      )}

      <aside
        // Панель закрывается по клику на ссылку внутри неё: переход в дереве
        // ведёт на другую страницу, и оставленная открытой панель перекрыла бы
        // её на телефоне. Кнопки (создать, переименовать, удалить) ссылками не
        // являются и панель не закрывают — это как раз то, что нужно.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] shrink-0 flex-col gap-3 border-r border-border bg-background p-3 transition-transform duration-200 md:static md:z-auto md:max-w-none md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="cursor-pointer self-end rounded-md border border-border px-2 py-1 text-xs text-muted md:hidden"
        >
          Закрыть
        </button>

        {sidebar}
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
