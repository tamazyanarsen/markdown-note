import Link from "next/link";
import type { ReactNode } from "react";

import { loadOwnerTree } from "@/db/queries/tree";
import type { CurrentUser } from "@/lib/session";

import { SignOutButton } from "./sign-out-button";
import { TreeView } from "./tree/tree-view";

/** Оболочка личного кабинета: слева дерево, справа содержимое страницы. */
export async function AppShell({
  user,
  activeNoteId,
  children,
}: {
  user: CurrentUser;
  activeNoteId?: string;
  children: ReactNode;
}) {
  const tree = await loadOwnerTree(user.id);

  return (
    <div className="flex min-h-dvh">
      <aside className="flex w-72 shrink-0 flex-col gap-3 border-r border-border p-3">
        <div className="flex items-baseline justify-between gap-2">
          <Link href="/" className="text-base font-semibold">
            md-note
          </Link>
          <span className="truncate text-xs text-muted" title={user.email ?? user.id}>
            {user.email ?? user.name ?? "аккаунт"}
          </span>
        </div>

        <div className="min-h-0 flex-1">
          <TreeView tree={tree} activeNoteId={activeNoteId} />
        </div>

        <SignOutButton className="w-full cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface" />
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
