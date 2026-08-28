import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { loadOwnerTree } from "@/db/queries/tree";
import type { CurrentUser } from "@/lib/session";

import { AppShellFrame } from "./app-shell-frame";
import { SignOutButton } from "./sign-out-button";
import { TreeView } from "./tree/tree-view";

/** Cookie, в которой SidebarProvider держит свёрнутость колонки. */
const SIDEBAR_COOKIE_NAME = "sidebar_state";

/**
 * Оболочка личного кабинета: дерево и содержимое страницы.
 *
 * Раскладку держит AppShellFrame. Здесь остаётся только загрузка дерева
 * и состав боковой панели.
 */
export async function AppShell({
  user,
  activeNoteId,
  children,
}: {
  user: CurrentUser;
  activeNoteId?: string;
  children: ReactNode;
}) {
  const [tree, cookieStore] = await Promise.all([loadOwnerTree(user.id), cookies()]);

  // Читаем cookie на сервере, чтобы свёрнутая колонка не разворачивалась
  // на мгновение при загрузке страницы.
  const defaultOpen = cookieStore.get(SIDEBAR_COOKIE_NAME)?.value !== "false";

  return (
    <AppShellFrame
      defaultOpen={defaultOpen}
      sidebar={
        <>
          <SidebarHeader>
            <Link href="/" className="flex flex-col gap-0.5 px-2 py-1">
              <span className="font-heading text-sm font-semibold">md-note</span>
              <span
                className="truncate text-xs text-muted-foreground"
                title={user.email ?? user.id}
              >
                {user.email ?? user.name ?? "аккаунт"}
              </span>
            </Link>
          </SidebarHeader>

          <SidebarSeparator />

          {/* overflow-hidden вместо прокрутки по умолчанию: внутри дерева
              прокручивается только список, а кнопки «Папка»/«Заметка»
              остаются на месте. */}
          <SidebarContent className="overflow-hidden">
            <TreeView tree={tree} activeNoteId={activeNoteId} />
          </SidebarContent>

          <SidebarSeparator />

          <SidebarFooter>
            <SignOutButton />
          </SidebarFooter>
        </>
      }
    >
      {children}
    </AppShellFrame>
  );
}
