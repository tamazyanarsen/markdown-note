import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { findBacklinks } from "@/db/queries/links";
import { users } from "@/db/schema";
import { archiveNote, createNote, updateNote } from "@/domain/notes";

/**
 * Обратные ссылки между заметками.
 *
 * Проверяем то, чего не видно из юнит-теста на extractNoteLinks: что связи
 * действительно доезжают до базы при сохранении, исчезают при правке и не
 * пересекают границу владельца.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const FRANK = "ffffffff-6666-4666-8666-ffffffffffff";
const GRACE = "a7777777-7777-4777-8777-777777777777";

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [FRANK, GRACE]));
  await db.insert(users).values([
    { id: FRANK, email: "frank-links@example.com", isApproved: true },
    { id: GRACE, email: "grace-links@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [FRANK, GRACE]));
  await pool.end();
});

describe("обратные ссылки", () => {
  it("ссылка в тексте появляется у цели как бэклинк", async () => {
    const target = await createNote(FRANK, { title: "Цель", folderId: null });

    const source = await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `Подробности — в [цели](/n/${target.id}).`,
    });

    const backlinks = await findBacklinks(FRANK, target.id);

    expect(backlinks.map((note) => note.id)).toEqual([source.id]);
    expect(backlinks[0].title).toBe("Источник");
  });

  it("правка текста убирает исчезнувшую ссылку", async () => {
    const target = await createNote(FRANK, { title: "Цель", folderId: null });
    const source = await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `[цель](/n/${target.id})`,
    });

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(1);

    await updateNote(FRANK, source.id, { content: "Ссылки больше нет." });

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(0);
  });

  it("правка одного заголовка связи не трогает", async () => {
    // content в запросе не участвует, значит и разбирать нечего.
    const target = await createNote(FRANK, { title: "Цель", folderId: null });
    const source = await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `[цель](/n/${target.id})`,
    });

    await updateNote(FRANK, source.id, { title: "Другое название" });

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(1);
    expect((await findBacklinks(FRANK, target.id))[0].id).toBe(source.id);
  });

  it("связь с чужой заметкой не создаётся", async () => {
    // Ссылку на чужой UUID написать можно — она просто не станет связью.
    const foreign = await createNote(GRACE, { title: "Чужая", folderId: null });

    await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `[чужая](/n/${foreign.id})`,
    });

    expect(await findBacklinks(GRACE, foreign.id)).toHaveLength(0);
    expect(await findBacklinks(FRANK, foreign.id)).toHaveLength(0);
  });

  it("архивная заметка не показывается в бэклинках", async () => {
    const target = await createNote(FRANK, { title: "Цель", folderId: null });
    const source = await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `[цель](/n/${target.id})`,
    });

    await archiveNote(FRANK, source.id);

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(0);
  });

  it("две ссылки на одну заметку дают один бэклинк", async () => {
    const target = await createNote(FRANK, { title: "Цель", folderId: null });

    await createNote(FRANK, {
      title: "Источник",
      folderId: null,
      content: `[раз](/n/${target.id}) и [два](/n/${target.id})`,
    });

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(1);
  });

  it("ссылка внутри блока кода связью не становится", async () => {
    const target = await createNote(FRANK, { title: "Цель", folderId: null });

    await createNote(FRANK, {
      title: "Документация",
      folderId: null,
      content: ["Так выглядит ссылка:", "", "```md", `[цель](/n/${target.id})`, "```"].join(
        "\n",
      ),
    });

    expect(await findBacklinks(FRANK, target.id)).toHaveLength(0);
  });

  it("ссылка на саму себя не создаёт связи", async () => {
    // На неё есть check-ограничение в схеме: если бы отсев в extractNoteLinks
    // отвалился, вставка упала бы целой транзакцией и сохранение сломалось.
    const note = await createNote(FRANK, { title: "Заметка", folderId: null });

    await updateNote(FRANK, note.id, {
      content: `Ссылка [сюда же](/n/${note.id}).`,
    });

    expect(await findBacklinks(FRANK, note.id)).toHaveLength(0);
  });
});
