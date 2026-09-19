import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { loadOwnerTree } from "@/db/queries/tree";
import { folders, noteChunks, noteLinks, notes, users } from "@/db/schema";
import { createAttachment } from "@/domain/attachments";
import { archiveFolder, createFolder } from "@/domain/folders";
import {
  archiveNote,
  createNote,
  getNoteForViewer,
  setNoteVisibility,
} from "@/domain/notes";
import {
  emptyTrash,
  listTrash,
  purgeExpired,
  purgeFolder,
  purgeNote,
  restoreFolder,
  restoreNote,
  TRASH_RETENTION_DAYS,
} from "@/domain/trash";
import { AppError } from "@/lib/errors";
import { attachmentPath } from "@/lib/uploads";

/**
 * Корзина.
 *
 * Главное здесь — группы. «Удалено одним действием» определяется равенством
 * archived_at, и почти каждая проверка ниже про то, что группа не
 * захватывает лишнего: соседняя ветка, отправленная в корзину раньше,
 * не должна ни восстановиться заодно, ни пропасть под каскадом.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const OLGA = "cccccccc-2020-4020-8020-cccccccccccc";
const PAVEL = "dddddddd-2121-4021-8021-dddddddddddd";

const PNG = "image/png";

async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(action()).rejects.toThrowError(AppError);
  await action().catch((error: AppError) => {
    expect(error.code).toBe(code);
  });
}

/**
 * Имя нарушенного констрейнта.
 *
 * drizzle заворачивает ошибку драйвера в свою, с текстом «Failed query»,
 * а подробности оставляет в cause — там же, где их видит и toErrorResponse.
 */
async function violatedConstraint(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? "";
  }

  throw new Error("запрос прошёл, хотя должен был упереться в констрейнт");
}

/** Сдвигает дату удаления в прошлое: ждать тридцать дней в тесте нечем. */
async function ageTrash(ownerId: string, days: number): Promise<void> {
  const shift = `${days} days`;

  await db.execute(sql`
    update notes set archived_at = archived_at - ${shift}::interval
    where owner_id = ${ownerId} and is_archived = true
  `);
  await db.execute(sql`
    update folders set archived_at = archived_at - ${shift}::interval
    where owner_id = ${ownerId} and is_archived = true
  `);
}

let uploadsDir: string;
const savedUploadsDir = process.env.UPLOADS_DIR;

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), "md-note-trash-"));
  process.env.UPLOADS_DIR = uploadsDir;
});

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [OLGA, PAVEL]));
  await db.insert(users).values([
    { id: OLGA, email: "olga-trash@example.com", isApproved: true },
    { id: PAVEL, email: "pavel-trash@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [OLGA, PAVEL]));
  await pool.end();

  if (savedUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = savedUploadsDir;

  await rm(uploadsDir, { recursive: true, force: true });
});

describe("список", () => {
  it("показывает удалённую заметку и убирает её отовсюду ещё", async () => {
    const note = await createNote(OLGA, { title: "Черновик", folderId: null });
    await setNoteVisibility(OLGA, note.id, "public");
    await archiveNote(OLGA, note.id);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "note", id: note.id, title: "Черновик" });
    expect(items[0].archivedAt).toBeInstanceOf(Date);

    expect(await loadOwnerTree(OLGA)).toHaveLength(0);

    // Публикация архивной заметки не спасает: страница обязана отвечать 404.
    expect(await getNoteForViewer(note.id, OLGA)).toBeNull();
    expect(await getNoteForViewer(note.id, null)).toBeNull();
  });

  it("удалённая папка — одна строка со счётчиком заметок внутри", async () => {
    const folder = await createFolder(OLGA, { title: "Проект", parentId: null });
    const inner = await createFolder(OLGA, { title: "Внутри", parentId: folder.id });
    await createNote(OLGA, { title: "Первая", folderId: folder.id });
    await createNote(OLGA, { title: "Вторая", folderId: inner.id });

    await archiveFolder(OLGA, folder.id);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "folder",
      id: folder.id,
      title: "Проект",
      noteCount: 2,
    });
  });

  it("заметка, удалённая раньше папки, остаётся отдельной строкой", async () => {
    const folder = await createFolder(OLGA, { title: "Проект", parentId: null });
    const early = await createNote(OLGA, { title: "Ранняя", folderId: folder.id });
    await createNote(OLGA, { title: "Поздняя", folderId: folder.id });

    await archiveNote(OLGA, early.id);
    await archiveFolder(OLGA, folder.id);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(2);

    const folderItem = items.find((item) => item.kind === "folder");
    const noteItem = items.find((item) => item.kind === "note");

    expect(noteItem).toMatchObject({ id: early.id, title: "Ранняя" });
    // Ранняя заметка в счётчик папки не входит: она из другой группы.
    expect(folderItem).toMatchObject({ id: folder.id, noteCount: 1 });
    expect(folderItem!.archivedAt).not.toEqual(noteItem!.archivedAt);
  });

  it("чужая корзина не видна", async () => {
    const note = await createNote(PAVEL, { title: "Чужая", folderId: null });
    await archiveNote(PAVEL, note.id);

    expect(await listTrash(OLGA)).toHaveLength(0);
  });
});

describe("восстановление заметки", () => {
  it("возвращает заметку в живую папку на прежнее место", async () => {
    const folder = await createFolder(OLGA, { title: "Папка", parentId: null });
    const note = await createNote(OLGA, { title: "Заметка", folderId: folder.id });

    await archiveNote(OLGA, note.id);
    const restored = await restoreNote(OLGA, note.id);

    expect(restored.folderId).toBe(folder.id);
    expect(restored.position).toBe(note.position);
    expect(restored.isArchived).toBe(false);
    expect(await listTrash(OLGA)).toHaveLength(0);
  });

  it("поднимает заметку в корень, если папка осталась в корзине", async () => {
    const folder = await createFolder(OLGA, { title: "Папка", parentId: null });
    const note = await createNote(OLGA, { title: "Заметка", folderId: folder.id });

    await archiveFolder(OLGA, folder.id);
    const restored = await restoreNote(OLGA, note.id);

    expect(restored.folderId).toBeNull();
    expect(restored.isArchived).toBe(false);

    // Папка осталась удалённой и в списке — но уже без заметок внутри.
    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "folder", id: folder.id, noteCount: 0 });
  });

  it("чужую заметку не восстановить", async () => {
    const note = await createNote(PAVEL, { title: "Чужая", folderId: null });
    await archiveNote(PAVEL, note.id);

    await expectAppError(() => restoreNote(OLGA, note.id), "NOT_FOUND");
  });

  it("живую заметку восстанавливать нечего", async () => {
    const note = await createNote(OLGA, { title: "Живая", folderId: null });

    await expectAppError(() => restoreNote(OLGA, note.id), "NOT_FOUND");
  });
});

describe("восстановление папки", () => {
  it("возвращает всю группу и не трогает соседнюю", async () => {
    const folder = await createFolder(OLGA, { title: "Проект", parentId: null });
    const inner = await createFolder(OLGA, { title: "Внутри", parentId: folder.id });
    const early = await createNote(OLGA, { title: "Ранняя", folderId: inner.id });
    const late = await createNote(OLGA, { title: "Поздняя", folderId: inner.id });

    await archiveNote(OLGA, early.id);
    await archiveFolder(OLGA, folder.id);

    await restoreFolder(OLGA, folder.id);

    const tree = await loadOwnerTree(OLGA);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(folder.id);

    const [lateRow] = await db
      .select({ isArchived: notes.isArchived, folderId: notes.folderId })
      .from(notes)
      .where(eq(notes.id, late.id));
    expect(lateRow.isArchived).toBe(false);
    expect(lateRow.folderId).toBe(inner.id);

    // Ранняя заметка из другой группы — осталась в корзине.
    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "note", id: early.id });
  });

  it("поднимает папку в корень, если родитель остался в корзине", async () => {
    const outer = await createFolder(OLGA, { title: "Внешняя", parentId: null });
    const inner = await createFolder(OLGA, { title: "Внутренняя", parentId: outer.id });

    // Внутреннюю удаляем отдельно и раньше — это своя группа.
    await archiveFolder(OLGA, inner.id);
    await archiveFolder(OLGA, outer.id);

    const restored = await restoreFolder(OLGA, inner.id);

    expect(restored.parentId).toBeNull();
    expect(restored.isArchived).toBe(false);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "folder", id: outer.id });
  });

  it("чужую папку не восстановить", async () => {
    const folder = await createFolder(PAVEL, { title: "Чужая", parentId: null });
    await archiveFolder(PAVEL, folder.id);

    await expectAppError(() => restoreFolder(OLGA, folder.id), "NOT_FOUND");
  });
});

describe("удаление насовсем", () => {
  it("уносит заметку со связями, векторами, вложениями и файлом", async () => {
    const target = await createNote(OLGA, { title: "Цель", folderId: null });
    const note = await createNote(OLGA, {
      title: "Заметка",
      folderId: null,
      content: `Ссылка: [цель](/n/${target.id})`,
    });

    const uploaded = await createAttachment(OLGA, note.id, {
      name: "картинка.png",
      type: PNG,
      bytes: Buffer.alloc(32, 1),
    });

    await db.insert(noteChunks).values({
      noteId: note.id,
      chunkIndex: 0,
      sourceHash: "hash",
      text: "текст",
      embedding: Array.from({ length: 1024 }, () => 0),
    });

    const file = attachmentPath(OLGA, uploaded.id, PNG);
    expect((await stat(file)).size).toBe(32);

    await archiveNote(OLGA, note.id);
    await purgeNote(OLGA, note.id);

    expect(
      await db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(noteLinks).where(eq(noteLinks.sourceNoteId, note.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(noteChunks).where(eq(noteChunks.noteId, note.id)),
    ).toHaveLength(0);

    await expect(stat(file)).rejects.toThrow();

    // Цель ссылки — живая заметка, её каскад задеть не должен.
    expect(
      await db.select().from(notes).where(eq(notes.id, target.id)),
    ).toHaveLength(1);
  });

  it("живую заметку насовсем не удалить", async () => {
    const note = await createNote(OLGA, { title: "Живая", folderId: null });

    await expectAppError(() => purgeNote(OLGA, note.id), "NOT_FOUND");
  });

  it("удаление папки не уносит каскадом ветку из другой группы", async () => {
    const outer = await createFolder(OLGA, { title: "Внешняя", parentId: null });
    const inner = await createFolder(OLGA, { title: "Внутренняя", parentId: outer.id });
    const innerNote = await createNote(OLGA, { title: "Внутри", folderId: inner.id });
    const outerNote = await createNote(OLGA, { title: "Снаружи", folderId: outer.id });

    await archiveFolder(OLGA, inner.id);
    await archiveFolder(OLGA, outer.id);

    await purgeFolder(OLGA, outer.id);

    // Внешняя папка и её заметка исчезли.
    expect(
      await db.select().from(folders).where(eq(folders.id, outer.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(notes).where(eq(notes.id, outerNote.id)),
    ).toHaveLength(0);

    // Внутренняя ветка цела и отцеплена в корень корзины.
    const [innerRow] = await db
      .select({ parentId: folders.parentId, isArchived: folders.isArchived })
      .from(folders)
      .where(eq(folders.id, inner.id));
    expect(innerRow).toMatchObject({ parentId: null, isArchived: true });

    expect(
      await db.select().from(notes).where(eq(notes.id, innerNote.id)),
    ).toHaveLength(1);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "folder", id: inner.id, noteCount: 1 });
  });

  it("чужую папку насовсем не удалить", async () => {
    const folder = await createFolder(PAVEL, { title: "Чужая", parentId: null });
    await archiveFolder(PAVEL, folder.id);

    await expectAppError(() => purgeFolder(OLGA, folder.id), "NOT_FOUND");
  });

  it("очистка уносит всю корзину и не трогает живое", async () => {
    const folder = await createFolder(OLGA, { title: "Папка", parentId: null });
    await createNote(OLGA, { title: "В папке", folderId: folder.id });
    const alive = await createNote(OLGA, { title: "Живая", folderId: null });
    const doomed = await createNote(OLGA, { title: "Удалённая", folderId: null });

    await archiveFolder(OLGA, folder.id);
    await archiveNote(OLGA, doomed.id);

    await emptyTrash(OLGA);

    expect(await listTrash(OLGA)).toHaveLength(0);

    const tree = await loadOwnerTree(OLGA);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(alive.id);
  });

  it("очистка не трогает чужую корзину", async () => {
    const mine = await createNote(OLGA, { title: "Моя", folderId: null });
    const theirs = await createNote(PAVEL, { title: "Чужая", folderId: null });

    await archiveNote(OLGA, mine.id);
    await archiveNote(PAVEL, theirs.id);

    await emptyTrash(OLGA);

    expect(await listTrash(OLGA)).toHaveLength(0);
    expect(await listTrash(PAVEL)).toHaveLength(1);
  });
});

describe("срок хранения", () => {
  it("уносит просроченное и оставляет свежее", async () => {
    const old = await createNote(OLGA, { title: "Старая", folderId: null });
    await archiveNote(OLGA, old.id);
    await ageTrash(OLGA, TRASH_RETENTION_DAYS + 1);

    const fresh = await createNote(OLGA, { title: "Свежая", folderId: null });
    await archiveNote(OLGA, fresh.id);

    await purgeExpired(OLGA);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(fresh.id);
  });

  it("не трогает то, чему срок ещё не вышел", async () => {
    const note = await createNote(OLGA, { title: "Почти", folderId: null });
    await archiveNote(OLGA, note.id);
    await ageTrash(OLGA, TRASH_RETENTION_DAYS - 1);

    await purgeExpired(OLGA);

    expect(await listTrash(OLGA)).toHaveLength(1);
  });

  it("заметка переживает просроченную папку и всплывает в корень корзины", async () => {
    const folder = await createFolder(OLGA, { title: "Папка", parentId: null });
    const note = await createNote(OLGA, { title: "Заметка", folderId: folder.id });

    // Заметку удалили раньше и отдельно — у неё свой срок.
    await archiveNote(OLGA, note.id);
    await ageTrash(OLGA, TRASH_RETENTION_DAYS - 1);
    await archiveFolder(OLGA, folder.id);

    // Теперь состарим только папку: сдвиг применяется ко всей корзине,
    // поэтому заметке останется ровно два дня до срока.
    await db.execute(sql`
      update folders set archived_at = archived_at - ${`${TRASH_RETENTION_DAYS + 1} days`}::interval
      where owner_id = ${OLGA} and id = ${folder.id}
    `);

    await purgeExpired(OLGA);

    const items = await listTrash(OLGA);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "note", id: note.id });

    const [row] = await db
      .select({ folderId: notes.folderId })
      .from(notes)
      .where(eq(notes.id, note.id));
    expect(row.folderId).toBeNull();
  });

  it("вложенная папка переживает просроченного родителя", async () => {
    const outer = await createFolder(OLGA, { title: "Внешняя", parentId: null });
    const inner = await createFolder(OLGA, { title: "Внутренняя", parentId: outer.id });

    await archiveFolder(OLGA, inner.id);
    await archiveFolder(OLGA, outer.id);

    await db.execute(sql`
      update folders set archived_at = archived_at - ${`${TRASH_RETENTION_DAYS + 1} days`}::interval
      where owner_id = ${OLGA} and id = ${outer.id}
    `);

    await purgeExpired(OLGA);

    const [innerRow] = await db
      .select({ parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, inner.id));
    expect(innerRow).toBeDefined();
    expect(innerRow.parentId).toBeNull();
  });

  it("список сам подчищает просроченное", async () => {
    const note = await createNote(OLGA, { title: "Старая", folderId: null });
    await archiveNote(OLGA, note.id);
    await ageTrash(OLGA, TRASH_RETENTION_DAYS + 1);

    expect(await listTrash(OLGA)).toHaveLength(0);
    expect(
      await db.select().from(notes).where(eq(notes.id, note.id)),
    ).toHaveLength(0);
  });
});

describe("инвариант флага", () => {
  it("архивная строка без даты удаления невозможна", async () => {
    const note = await createNote(OLGA, { title: "Заметка", folderId: null });

    const constraint = await violatedConstraint(() =>
      db
        .update(notes)
        .set({ isArchived: true })
        .where(and(eq(notes.id, note.id), eq(notes.ownerId, OLGA))),
    );

    expect(constraint).toBe("notes_archived_at_matches_flag");
  });

  it("живая строка с датой удаления невозможна", async () => {
    const folder = await createFolder(OLGA, { title: "Папка", parentId: null });

    const constraint = await violatedConstraint(() =>
      db
        .update(folders)
        .set({ archivedAt: new Date() })
        .where(and(eq(folders.id, folder.id), eq(folders.ownerId, OLGA))),
    );

    expect(constraint).toBe("folders_archived_at_matches_flag");
  });
});
