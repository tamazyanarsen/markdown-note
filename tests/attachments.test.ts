import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { users } from "@/db/schema";
import { createAttachment, getAttachmentForViewer } from "@/domain/attachments";
import { archiveNote, createNote, setNoteVisibility } from "@/domain/notes";
import { AppError } from "@/lib/errors";
import { attachmentPath } from "@/lib/uploads";
import { LIMITS } from "@/lib/validation";

/**
 * Вложения заметок.
 *
 * Главное здесь — правило доступа: у файла нет своей видимости, она берётся
 * у заметки. Проверяем оба направления (публикация открывает, возврат в
 * private закрывает) и то, что чужому не достаётся ничего.
 *
 * Файлы пишутся во временный каталог: UPLOADS_DIR читается на каждый вызов
 * именно для этого.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const JULIA = "aaaaaaaa-1010-4010-8010-aaaaaaaaaaaa";
const KIRILL = "bbbbbbbb-1111-4011-8011-bbbbbbbbbbbb";

const PNG = "image/png";

/** Минимальные «байты картинки»: содержимое нас не интересует, только размер. */
function bytes(size: number): Buffer {
  return Buffer.alloc(size, 1);
}

async function expectAppError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(action()).rejects.toThrowError(AppError);
  await action().catch((error: AppError) => {
    expect(error.code).toBe(code);
  });
}

let uploadsDir: string;
const savedUploadsDir = process.env.UPLOADS_DIR;

beforeAll(async () => {
  uploadsDir = await mkdtemp(path.join(tmpdir(), "md-note-uploads-"));
  process.env.UPLOADS_DIR = uploadsDir;
});

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [JULIA, KIRILL]));
  await db.insert(users).values([
    { id: JULIA, email: "julia-files@example.com", isApproved: true },
    { id: KIRILL, email: "kirill-files@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [JULIA, KIRILL]));
  await pool.end();

  if (savedUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = savedUploadsDir;

  await rm(uploadsDir, { recursive: true, force: true });
});

describe("загрузка", () => {
  it("кладёт файл на диск и возвращает адрес для markdown", async () => {
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });

    const uploaded = await createAttachment(JULIA, note.id, {
      name: "скриншот.png",
      type: PNG,
      bytes: bytes(64),
    });

    expect(uploaded.url).toBe(`/api/files/${uploaded.id}`);
    expect(uploaded.inline).toBe(true);
    expect(uploaded.byteSize).toBe(64);

    const written = await stat(attachmentPath(JULIA, uploaded.id, PNG));
    expect(written.size).toBe(64);
  });

  it("pdf вставляется ссылкой, а не картинкой", async () => {
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });

    const uploaded = await createAttachment(JULIA, note.id, {
      name: "договор.pdf",
      type: "application/pdf",
      bytes: bytes(32),
    });

    expect(uploaded.inline).toBe(false);
  });

  it("вычищает из имени скобки, ломающие markdown-ссылку", async () => {
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });

    const uploaded = await createAttachment(JULIA, note.id, {
      name: "снимок [1].png",
      type: PNG,
      bytes: bytes(16),
    });

    expect(uploaded.filename).toBe("снимок 1.png");
  });

  it("в чужую заметку загрузить нельзя", async () => {
    const foreign = await createNote(KIRILL, { title: "Чужая", folderId: null });

    await expectAppError(
      () =>
        createAttachment(JULIA, foreign.id, {
          name: "x.png",
          type: PNG,
          bytes: bytes(16),
        }),
      "NOT_FOUND",
    );
  });

  it("не принимает неразрешённый тип", async () => {
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });

    await expectAppError(
      () =>
        createAttachment(JULIA, note.id, {
          name: "картинка.svg",
          type: "image/svg+xml",
          bytes: bytes(16),
        }),
      "VALIDATION_ERROR",
    );
  });

  it("не принимает файл сверх лимита", async () => {
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });

    await expectAppError(
      () =>
        createAttachment(JULIA, note.id, {
          name: "большой.png",
          type: PNG,
          bytes: bytes(LIMITS.attachmentMaxBytes + 1),
        }),
      "VALIDATION_ERROR",
    );
  });
});

describe("доступ", () => {
  it("вложение приватной заметки видит только владелец", async () => {
    const note = await createNote(JULIA, { title: "Личное", folderId: null });
    const uploaded = await createAttachment(JULIA, note.id, {
      name: "x.png",
      type: PNG,
      bytes: bytes(16),
    });

    expect(await getAttachmentForViewer(uploaded.id, JULIA)).not.toBeNull();
    expect(await getAttachmentForViewer(uploaded.id, KIRILL)).toBeNull();
    expect(await getAttachmentForViewer(uploaded.id, null)).toBeNull();
  });

  it("публикация заметки открывает её вложения гостю", async () => {
    const note = await createNote(JULIA, { title: "Статья", folderId: null });
    const uploaded = await createAttachment(JULIA, note.id, {
      name: "x.png",
      type: PNG,
      bytes: bytes(16),
    });

    await setNoteVisibility(JULIA, note.id, "public");

    expect(await getAttachmentForViewer(uploaded.id, null)).not.toBeNull();
  });

  it("возврат заметки в private снова закрывает вложение", async () => {
    const note = await createNote(JULIA, { title: "Статья", folderId: null });
    const uploaded = await createAttachment(JULIA, note.id, {
      name: "x.png",
      type: PNG,
      bytes: bytes(16),
    });

    await setNoteVisibility(JULIA, note.id, "public");
    await setNoteVisibility(JULIA, note.id, "private");

    expect(await getAttachmentForViewer(uploaded.id, null)).toBeNull();
    expect(await getAttachmentForViewer(uploaded.id, JULIA)).not.toBeNull();
  });

  it("архивная заметка не отдаёт вложения даже владельцу", async () => {
    // Так же ведёт себя её страница: архивной заметки для приложения нет.
    const note = await createNote(JULIA, { title: "Заметка", folderId: null });
    const uploaded = await createAttachment(JULIA, note.id, {
      name: "x.png",
      type: PNG,
      bytes: bytes(16),
    });

    await archiveNote(JULIA, note.id);

    expect(await getAttachmentForViewer(uploaded.id, JULIA)).toBeNull();
  });
});
