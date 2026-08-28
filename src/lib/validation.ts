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
