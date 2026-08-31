import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";

import { AppShell } from "@/components/app-shell";
import { NoteEditor } from "@/components/note/note-editor";
import { PublicFooter } from "@/components/public-footer";
import { getNoteForViewer, renderNoteHtml, saveNoteHtml } from "@/domain/notes";
import { markdownExcerpt } from "@/lib/markdown";
import { getCurrentUser } from "@/lib/session";
import { parseResourceId } from "@/lib/validation";

/**
 * /n/:noteId — единая ссылка на заметку.
 *
 * Владелец получает редактор, все остальные — отрендеренный markdown,
 * и только если заметка public. Во всех прочих случаях 404: ответ 403
 * подтвердил бы, что заметка с таким UUID существует.
 */

/**
 * cache() — потому что за один запрос loadNote зовётся дважды: из
 * generateMetadata и из самой страницы. Без него это два одинаковых
 * похода в базу вместо одного.
 */
const loadNote = cache(async (noteIdParam: string) => {
  const id = parseResourceId(noteIdParam);
  if (!id) return null;

  const viewer = await getCurrentUser();
  const loaded = await getNoteForViewer(id, viewer?.id ?? null);
  if (!loaded) return null;

  return { ...loaded, viewer };
});

export async function generateMetadata({
  params,
}: PageProps<"/n/[noteId]">): Promise<Metadata> {
  const { noteId } = await params;
  const loaded = await loadNote(noteId);

  // Заголовок недоступной заметки не попадает даже в <title>.
  if (!loaded) return { title: "Не найдено" };

  return {
    title: loaded.note.title,
    description: markdownExcerpt(loaded.note.content, 160) || undefined,
    // Личные заметки не должны попадать в поисковую выдачу: ссылками
    // делятся адресно. Убери эту строку, если индексация нужна.
    robots: { index: false, follow: false },
  };
}

export default async function NotePage({ params }: PageProps<"/n/[noteId]">) {
  const { noteId } = await params;
  const loaded = await loadNote(noteId);
  if (!loaded) notFound();

  const { note, contentHtml, viewer } = loaded;

  if (viewer?.id === note.ownerId && viewer.isApproved) {
    return (
      <AppShell user={viewer} activeNoteId={note.id}>
        <NoteEditor note={note} />
      </AppShell>
    );
  }

  const { html, cached } = await renderNoteHtml({ note, contentHtml });

  // Запись кеша уходит после ответа: посетителю незачем ждать UPDATE.
  if (!cached) after(() => saveNoteHtml(note.id, note.content, html));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <article>
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">{note.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Обновлено{" "}
          <time dateTime={note.updatedAt.toISOString()}>
            {note.updatedAt.toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </time>
        </p>

        <div
          className="prose prose-neutral dark:prose-invert mt-6 max-w-none"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>

      <PublicFooter />
    </div>
  );
}
