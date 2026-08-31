import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { notes, users } from "@/db/schema";
import {
  createNote,
  getNoteForViewer,
  renderNoteHtml,
  saveNoteHtml,
  setNoteVisibility,
  updateNote,
} from "@/domain/notes";

/**
 * Кеш рендера markdown в notes.content_html.
 *
 * Инвариант, ради которого всё написано: из кеша нельзя достать html,
 * не соответствующий текущему content. Проверяем обе стороны — что кеш
 * действительно переиспользуется и что он вовремя сбрасывается.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const CAROL = "cccccccc-3333-4333-8333-cccccccccccc";

/** Читает кеш напрямую, минуя доменные функции. */
async function readCache(noteId: string): Promise<string | null> {
  const [row] = await db
    .select({ contentHtml: notes.contentHtml })
    .from(notes)
    .where(eq(notes.id, noteId));

  return row.contentHtml;
}

/** Полный путь публичной страницы: прочитать, отрендерить, сохранить. */
async function renderPage(noteId: string) {
  const loaded = await getNoteForViewer(noteId, null);
  if (!loaded) throw new Error("заметка недоступна");

  const { html, cached } = await renderNoteHtml(loaded);
  if (!cached) await saveNoteHtml(loaded.note.id, loaded.note.content, html);

  return { html, cached };
}

async function createPublicNote(content: string) {
  const note = await createNote(CAROL, {
    title: "Заметка",
    folderId: null,
    content,
  });

  await setNoteVisibility(CAROL, note.id, "public");
  return note;
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [CAROL]));
  await db
    .insert(users)
    .values({ id: CAROL, email: "carol-cache@example.com", isApproved: true });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [CAROL]));
  await pool.end();
});

describe("кеш рендера", () => {
  it("первый показ рендерит и заполняет кеш, второй берёт готовое", async () => {
    const note = await createPublicNote("# Привет\n\nТекст.");

    const first = await renderPage(note.id);
    expect(first.cached).toBe(false);
    expect(first.html).toContain("<h1>Привет</h1>");
    expect(await readCache(note.id)).toBe(first.html);

    const second = await renderPage(note.id);
    expect(second.cached).toBe(true);
    expect(second.html).toBe(first.html);
  });

  it("правка текста сбрасывает кеш", async () => {
    const note = await createPublicNote("Было");
    await renderPage(note.id);

    await updateNote(CAROL, note.id, { content: "Стало" });

    expect(await readCache(note.id)).toBeNull();

    const rerendered = await renderPage(note.id);
    expect(rerendered.cached).toBe(false);
    expect(rerendered.html).toContain("Стало");
  });

  it("правка одного заголовка кеш не трогает", async () => {
    const note = await createPublicNote("Текст");
    const { html } = await renderPage(note.id);

    await updateNote(CAROL, note.id, { title: "Другой заголовок" });

    expect(await readCache(note.id)).toBe(html);
  });

  it("публикация и снятие публикации кеш не трогают", async () => {
    const note = await createPublicNote("Текст");
    const { html } = await renderPage(note.id);

    await setNoteVisibility(CAROL, note.id, "private");
    await setNoteVisibility(CAROL, note.id, "public");

    expect(await readCache(note.id)).toBe(html);
  });

  it("не сохраняет html, если текст изменился во время рендера", async () => {
    const note = await createPublicNote("Исходный");

    // Страница успела прочитать заметку до правки...
    const loaded = await getNoteForViewer(note.id, null);
    const { html } = await renderNoteHtml(loaded!);

    // ...а автосохранение прошло раньше, чем страница дописала кеш.
    await updateNote(CAROL, note.id, { content: "Новый" });
    await saveNoteHtml(note.id, "Исходный", html);

    // Устаревший html не должен был попасть в базу.
    expect(await readCache(note.id)).toBeNull();
  });

  it("не отдаёт кеш наружу вместе с заметкой", async () => {
    const note = await createPublicNote("Текст");
    await renderPage(note.id);

    const loaded = await getNoteForViewer(note.id, null);

    expect(loaded!.contentHtml).not.toBeNull();
    expect(loaded!.note).not.toHaveProperty("contentHtml");
    expect(loaded!.note).not.toHaveProperty("searchVector");
  });
});
