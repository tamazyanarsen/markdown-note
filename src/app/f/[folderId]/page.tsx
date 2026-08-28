import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { StaticTree } from "@/components/tree/static-tree";
import {
  findSubtree,
  loadOwnerTree,
  loadPublicSubtree,
  type FolderNode,
} from "@/db/queries/tree";
import { db } from "@/db/client";
import { folders } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/session";
import { parseResourceId } from "@/lib/validation";

/**
 * /f/:folderId — ссылка на папку.
 *
 * Открывается для любого посетителя, но содержимое зависит от того, кто он:
 *  - владелец видит полное поддерево, включая private-заметки;
 *  - все остальные — только public-заметки и папки на пути к ним.
 *
 * Пустая для гостя папка — нормальный ответ 200, а не 404: сам факт
 * существования папки не секрет, секретно её содержимое.
 */

async function loadFolderView(folderIdParam: string) {
  const id = parseResourceId(folderIdParam);
  if (!id) return null;

  const viewer = await getCurrentUser();

  if (viewer?.isApproved) {
    const [owned] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          eq(folders.id, id),
          eq(folders.ownerId, viewer.id),
          eq(folders.isArchived, false),
        ),
      );

    if (owned) {
      const subtree = findSubtree(await loadOwnerTree(viewer.id), id);
      if (subtree) return { mode: "owner" as const, viewer, root: subtree };
    }
  }

  const root = await loadPublicSubtree(id);
  if (!root) return null;

  return { mode: "public" as const, viewer, root };
}

export async function generateMetadata({
  params,
}: PageProps<"/f/[folderId]">): Promise<Metadata> {
  const { folderId } = await params;
  const view = await loadFolderView(folderId);

  if (!view) return { title: "Не найдено" };

  return {
    title: view.root.title,
    robots: { index: false, follow: false },
  };
}

export default async function FolderPage({ params }: PageProps<"/f/[folderId]">) {
  const { folderId } = await params;
  const view = await loadFolderView(folderId);
  if (!view) notFound();

  const body = <FolderBody root={view.root} publicOnly={view.mode === "public"} />;

  if (view.mode === "owner") {
    return (
      <AppShell user={view.viewer!}>
        <div className="p-8">{body}</div>
      </AppShell>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      {body}
      <footer className="mt-12 border-t border-border pt-4 text-xs text-muted">
        <Link href="/" className="hover:text-foreground">
          md-note
        </Link>
      </footer>
    </div>
  );
}

function FolderBody({ root, publicOnly }: { root: FolderNode; publicOnly: boolean }) {
  return (
    <>
      <h1 className="text-2xl font-semibold">{root.title}</h1>
      {publicOnly && (
        <p className="mt-1 text-xs text-muted">
          Показаны только опубликованные заметки.
        </p>
      )}
      <div className="mt-6">
        <StaticTree nodes={root.children} />
      </div>
    </>
  );
}
