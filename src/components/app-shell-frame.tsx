"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

/**
 * Каркас личного кабинета поверх shadcn-компонента Sidebar.
 *
 * Sidebar сам решает, как себя показать: на широком экране это колонка,
 * которую можно свернуть (Ctrl/Cmd+B или кнопка в шапке), на узком — Sheet,
 * выезжающий поверх содержимого. Дерево не помещается в 360px телефона,
 * поэтому второй вариант обязателен.
 *
 * Компонент клиентский только ради контекста Sidebar. Само дерево и кнопку
 * выхода собирает серверный AppShell и передаёт сюда готовым JSX — так
 * TreeView остаётся там же, где был, и запрос к базе не переезжает в клиент.
 */
export function AppShellFrame({
  sidebar,
  children,
  defaultOpen = true,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  /** Состояние колонки из cookie: свёрнутость переживает перезагрузку. */
  defaultOpen?: boolean;
}) {
  return (
    // h-dvh, а не min-h-svh (значение по умолчанию у SidebarProvider):
    // прокрутка живёт внутри колонок, поэтому дерево и шапка редактора
    // остаются на месте, а не уезжают вверх вместе со страницей.
    // dvh — из-за сворачивающейся адресной строки мобильных браузеров.
    <SidebarProvider defaultOpen={defaultOpen} className="h-dvh min-h-0 overflow-hidden">
      <Sidebar collapsible="offcanvas">
        {sidebar}
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        {/* Шапка нужна и на широком экране: свёрнутую колонку иначе нечем
            вернуть обратно. */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <Link href="/" className="font-heading text-sm font-semibold">
            md-note
          </Link>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
