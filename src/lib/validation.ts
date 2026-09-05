import { z } from "zod";

import { validationError } from "./errors";

/**
 * Лимиты. Сервис публичный, поэтому размеры ограничены явно:
 * без этого одна заметка может занять всю базу.
 */
export const LIMITS = {
  titleMaxLength: 200,
  /** Markdown-исходник одной заметки. */
  contentMaxLength: 512 * 1024,
  notesPerUser: 5_000,
  foldersPerUser: 1_000,
  /**
   * Один файл вложения. Десять мегабайт — это скриншот любого разрешения
   * с запасом; выше начинается видео, которому в заметках делать нечего.
   * Значение обязано быть согласовано с client_max_body_size в
   * deploy/md-note-proxy.conf, иначе nginx отрежет запрос раньше нас
   * и человек увидит его страницу ошибки вместо нашего сообщения.
   */
  attachmentMaxBytes: 10 * 1024 * 1024,
  attachmentsPerUser: 2_000,
} as const;

export const uuidSchema = z.uuid();

const titleSchema = z
  .string()
  .trim()
  .min(1, "Название не может быть пустым")
  .max(LIMITS.titleMaxLength, `Название длиннее ${LIMITS.titleMaxLength} символов`);

const positionSchema = z
  .union([z.number(), z.string()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d+)?$/.test(value), "Позиция должна быть числом");

export const createFolderSchema = z.object({
  title: titleSchema,
  parentId: uuidSchema.nullish().transform((value) => value ?? null),
});

export const updateFolderSchema = z.object({
  title: titleSchema.optional(),
});

export const createNoteSchema = z.object({
  title: titleSchema,
  folderId: uuidSchema.nullish().transform((value) => value ?? null),
  content: z.string().max(LIMITS.contentMaxLength).optional(),
});

export const updateNoteSchema = z.object({
  title: titleSchema.optional(),
  content: z.string().max(LIMITS.contentMaxLength).optional(),
});

/**
 * GET /api/search — строка запроса из адреса, а не из тела.
 *
 * Минимум два символа: по одной букве полнотекстовый индекс вернул бы
 * половину базы, а смысловой запрос из одного символа не значит ничего —
 * платить за его векторизацию незачем.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(LIMITS.titleMaxLength),
  mode: z.enum(["fts", "hybrid"]).default("fts"),
});

/** POST /api/{notes|folders}/:id/move — контракт из docs/описание.md. */
export const moveSchema = z.object({
  targetFolderId: uuidSchema.nullish().transform((value) => value ?? null),
  position: positionSchema.optional(),
});

/** Парсит тело запроса и бросает AppError(VALIDATION_ERROR) при несоответствии. */
export async function parseBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError("Тело запроса не является корректным JSON");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw validationError(z.treeifyError(result.error));
  }

  return result.data;
}

/**
 * Идентификатор из URL. Невалидный UUID — это 404, а не 400:
 * по таблице ошибок из документа несуществующий ресурс и мусор в ссылке
 * выглядят для клиента одинаково.
 */
export function parseResourceId(value: string): string | null {
  const result = uuidSchema.safeParse(value);
  return result.success ? result.data : null;
}
