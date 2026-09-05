import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachmentPath,
  contentDisposition,
  isAllowedMimeType,
  isInlineImage,
} from "./uploads";

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FILE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

describe("белый список типов", () => {
  it("пропускает картинки и pdf", () => {
    expect(isAllowedMimeType("image/png")).toBe(true);
    expect(isAllowedMimeType("image/webp")).toBe(true);
    expect(isAllowedMimeType("application/pdf")).toBe(true);
  });

  it("не пропускает svg", () => {
    // Не картинка, а документ со скриптами: отдавать его со своего домена
    // значило бы открыть XSS в обход всей санитизации markdown.
    expect(isAllowedMimeType("image/svg+xml")).toBe(false);
  });

  it("не пропускает html и произвольные типы", () => {
    expect(isAllowedMimeType("text/html")).toBe(false);
    expect(isAllowedMimeType("application/octet-stream")).toBe(false);
    expect(isAllowedMimeType("")).toBe(false);
  });

  it("отличает картинку от файла на скачивание", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("application/pdf")).toBe(false);
  });
});

describe("путь к файлу", () => {
  const root = path.join("C:", "tmp", "md-note-uploads");
  const saved = process.env.UPLOADS_DIR;

  beforeEach(() => {
    process.env.UPLOADS_DIR = root;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = saved;
  });

  it("складывается из корня, владельца и id вложения", () => {
    expect(attachmentPath(OWNER, FILE, "image/png")).toBe(
      path.join(root, OWNER, `${FILE}.png`),
    );
  });

  it("расширение берёт из типа, а не из имени файла", () => {
    // Имя файла в путь не попадает вообще — поэтому «отчёт.png.html»
    // не может оказаться на диске как .html.
    expect(attachmentPath(OWNER, FILE, "application/pdf")).toBe(
      path.join(root, OWNER, `${FILE}.pdf`),
    );
  });

  it("не выходит за пределы корня", () => {
    // Обе подвижные части — UUID из базы, поэтому «..» в путь физически
    // не попадает. Проверка сторожит именно это свойство.
    const target = attachmentPath(OWNER, FILE, "image/jpeg");
    expect(path.relative(root, target).startsWith("..")).toBe(false);
  });
});

describe("contentDisposition", () => {
  it("кодирует кириллическое имя", () => {
    // Обычный filename= умеет только latin-1, а имена у нас русские.
    expect(contentDisposition("отчёт.pdf", false)).toBe(
      "attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf",
    );
  });

  it("не даёт кавычке закрыть заголовок", () => {
    const header = contentDisposition('стран"ное.png', true);
    expect(header.startsWith("inline; ")).toBe(true);
    expect(header).not.toContain('"');
  });
});
