import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { folders, notes, users } from "@/db/schema";
import { createFolder } from "@/domain/folders";
import { moveFolder, moveNote } from "@/domain/move";
import { createNote } from "@/domain/notes";
import { AppError } from "@/lib/errors";

/**
 * Проверяем правила перемещения из docs/описание.md напрямую на доменном
 * слое: именно здесь живут проверки владения, а не в HTTP-обвязке.
 *
 * Тесты работают с настоящим Postgres — нужен `npm run db:up`.
 */

const ALICE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** Проверяет, что вызов упал именно с ожидаемым доменным кодом и статусом. */
async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
  status: number,
) {
  await expect(action()).rejects.toThrowError(AppError);
  await action().catch((error: AppError) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
}

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
  await db.insert(users).values([
    { id: ALICE, email: "alice-move@example.com", isApproved: true },
    { id: BOB, email: "bob-move@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
  await pool.end();
});

describe("moveNote", () => {
  it("переносит заметку в другую свою папку", async () => {
    const from = await createFolder(ALICE, { title: "Откуда", parentId: null });
    const to = await createFolder(ALICE, { title: "Куда", parentId: null });
    const note = await createNote(ALICE, { title: "Заметка", folderId: from.id });

    const moved = await moveNote(ALICE, note.id, { targetFolderId: to.id });

    expect(moved.folderId).toBe(to.id);
  });

  it("переносит заметку в корень при targetFolderId = null", async () => {
    const folder = await createFolder(ALICE, { title: "Папка", parentId: null });
    const note = await createNote(ALICE, { title: "Заметка", folderId: folder.id });

    const moved = await moveNote(ALICE, note.id, { targetFolderId: null });

    expect(moved.folderId).toBeNull();
  });

  it("не меняет visibility при перемещении", async () => {
    const folder = await createFolder(ALICE, { title: "Папка", parentId: null });
    const note = await createNote(ALICE, { title: "Заметка", folderId: null });
    await db.update(notes).set({ visibility: "public" }).where(eq(notes.id, note.id));

    const moved = await moveNote(ALICE, note.id, { targetFolderId: folder.id });

    expect(moved.visibility).toBe("public");
  });

  it("чужую заметку двигать нельзя → 403 FORBIDDEN", async () => {
    const bobNote = await createNote(BOB, { title: "Заметка Боба", folderId: null });

    await expectAppError(
      () => moveNote(ALICE, bobNote.id, { targetFolderId: null }),
      "FORBIDDEN",
      403,
    );
  });

  it("свою заметку в чужую папку нельзя → 403 OWNER_MISMATCH", async () => {
    const aliceNote = await createNote(ALICE, { title: "Заметка", folderId: null });
    const bobFolder = await createFolder(BOB, { title: "Папка Боба", parentId: null });

    await expectAppError(
      () => moveNote(ALICE, aliceNote.id, { targetFolderId: bobFolder.id }),
      "OWNER_MISMATCH",
      403,
    );
  });

  it("несуществующая целевая папка → 404 TARGET_FOLDER_NOT_FOUND", async () => {
    const note = await createNote(ALICE, { title: "Заметка", folderId: null });

    await expectAppError(
      () =>
        moveNote(ALICE, note.id, {
          targetFolderId: "00000000-0000-4000-8000-000000000000",
        }),
      "TARGET_FOLDER_NOT_FOUND",
      404,
    );
  });

  it("архивная целевая папка тоже не подходит", async () => {
    const note = await createNote(ALICE, { title: "Заметка", folderId: null });
    const folder = await createFolder(ALICE, { title: "Архив", parentId: null });
    await db.update(folders).set({ isArchived: true }).where(eq(folders.id, folder.id));

    await expectAppError(
      () => moveNote(ALICE, note.id, { targetFolderId: folder.id }),
      "TARGET_FOLDER_NOT_FOUND",
      404,
    );
  });
});

describe("moveFolder", () => {
  it("переносит папку вместе с содержимым", async () => {
    const parent = await createFolder(ALICE, { title: "Родитель", parentId: null });
    const moving = await createFolder(ALICE, { title: "Переносимая", parentId: null });
    const child = await createFolder(ALICE, { title: "Ребёнок", parentId: moving.id });
    const note = await createNote(ALICE, { title: "Заметка", folderId: moving.id });

    await moveFolder(ALICE, moving.id, { targetFolderId: parent.id });

    // Меняется только parent_id самой папки; дети остаются при ней.
    const [childAfter] = await db.select().from(folders).where(eq(folders.id, child.id));
    const [noteAfter] = await db.select().from(notes).where(eq(notes.id, note.id));

    expect(childAfter.parentId).toBe(moving.id);
    expect(noteAfter.folderId).toBe(moving.id);
  });

  it("папку в саму себя нельзя → 409 FOLDER_MOVE_CYCLE", async () => {
    const folder = await createFolder(ALICE, { title: "Папка", parentId: null });

    await expectAppError(
      () => moveFolder(ALICE, folder.id, { targetFolderId: folder.id }),
      "FOLDER_MOVE_CYCLE",
      409,
    );
  });

  it("папку в своего прямого потомка нельзя → 409 FOLDER_MOVE_CYCLE", async () => {
    const parent = await createFolder(ALICE, { title: "Родитель", parentId: null });
    const child = await createFolder(ALICE, { title: "Ребёнок", parentId: parent.id });

    await expectAppError(
      () => moveFolder(ALICE, parent.id, { targetFolderId: child.id }),
      "FOLDER_MOVE_CYCLE",
      409,
    );
  });

  it("папку во внука тоже нельзя", async () => {
    const a = await createFolder(ALICE, { title: "A", parentId: null });
    const b = await createFolder(ALICE, { title: "B", parentId: a.id });
    const c = await createFolder(ALICE, { title: "C", parentId: b.id });

    await expectAppError(
      () => moveFolder(ALICE, a.id, { targetFolderId: c.id }),
      "FOLDER_MOVE_CYCLE",
      409,
    );
  });

  it("папку в соседнюю ветку — можно", async () => {
    const a = await createFolder(ALICE, { title: "A", parentId: null });
    const b = await createFolder(ALICE, { title: "B", parentId: null });
    const child = await createFolder(ALICE, { title: "Ребёнок A", parentId: a.id });

    const moved = await moveFolder(ALICE, child.id, { targetFolderId: b.id });

    expect(moved.parentId).toBe(b.id);
  });

  it("чужую папку двигать нельзя → 403 FORBIDDEN", async () => {
    const bobFolder = await createFolder(BOB, { title: "Папка Боба", parentId: null });

    await expectAppError(
      () => moveFolder(ALICE, bobFolder.id, { targetFolderId: null }),
      "FORBIDDEN",
      403,
    );
  });

  it("свою папку в чужую нельзя → 403 OWNER_MISMATCH", async () => {
    const aliceFolder = await createFolder(ALICE, { title: "Папка", parentId: null });
    const bobFolder = await createFolder(BOB, { title: "Папка Боба", parentId: null });

    await expectAppError(
      () => moveFolder(ALICE, aliceFolder.id, { targetFolderId: bobFolder.id }),
      "OWNER_MISMATCH",
      403,
    );
  });

  it("после отклонённого перемещения дерево не изменилось", async () => {
    const aliceFolder = await createFolder(ALICE, { title: "Папка", parentId: null });
    const bobFolder = await createFolder(BOB, { title: "Папка Боба", parentId: null });

    await moveFolder(ALICE, aliceFolder.id, { targetFolderId: bobFolder.id }).catch(
      () => undefined,
    );

    const [after] = await db
      .select()
      .from(folders)
      .where(eq(folders.id, aliceFolder.id));

    expect(after.parentId).toBeNull();
    expect(after.ownerId).toBe(ALICE);
  });
});

describe("ребалансировка позиций", () => {
  it("перенумеровывает соседей, когда зазор исчерпан", async () => {
    const folder = await createFolder(ALICE, { title: "Папка", parentId: null });
    const first = await createNote(ALICE, { title: "Первая", folderId: folder.id });
    const second = await createNote(ALICE, { title: "Вторая", folderId: folder.id });
    const third = await createNote(ALICE, { title: "Третья", folderId: folder.id });

    // Вручную загоняем соседей в неразличимо близкие позиции.
    await db.update(notes).set({ position: "1000" }).where(eq(notes.id, first.id));
    await db
      .update(notes)
      .set({ position: "1000.0000000001" })
      .where(eq(notes.id, second.id));

    await moveNote(ALICE, third.id, {
      targetFolderId: folder.id,
      position: "1000.0000000002",
    });

    const rows = await db
      .select({ id: notes.id, position: notes.position })
      .from(notes)
      .where(eq(notes.folderId, folder.id))
      .orderBy(notes.position);

    // Порядок сохранён, а позиции снова различимы.
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
    expect(rows.map((row) => Number(row.position))).toEqual([1000, 2000, 3000]);
  });
});
