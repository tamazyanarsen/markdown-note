/**
 * Доменные ошибки и их HTTP-коды — таблица «Ошибки» из docs/описание.md.
 *
 * Отдельно про чтение: гость, открывший чужую private-заметку, получает 404,
 * а не 403. 403 подтвердил бы, что заметка существует.
 */

export type AppErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "OWNER_MISMATCH"
  | "FOLDER_MOVE_CYCLE"
  | "TARGET_FOLDER_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED";

const HTTP_STATUS: Record<AppErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  OWNER_MISMATCH: 403,
  FOLDER_MOVE_CYCLE: 409,
  TARGET_FOLDER_NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export const unauthorized = () =>
  new AppError("UNAUTHORIZED", "Нужно войти в систему.");

export const notFound = () => new AppError("NOT_FOUND", "Ресурс не найден.");

export const forbidden = () =>
  new AppError("FORBIDDEN", "Недостаточно прав для этого действия.");

export const ownerMismatch = () =>
  new AppError(
    "OWNER_MISMATCH",
    "Перемещать ресурсы можно только внутри своего дерева.",
  );

export const folderMoveCycle = () =>
  new AppError(
    "FOLDER_MOVE_CYCLE",
    "Нельзя переместить папку внутрь самой себя или её потомка.",
  );

export const targetFolderNotFound = () =>
  new AppError("TARGET_FOLDER_NOT_FOUND", "Целевая папка не найдена.");

export const validationError = (details?: unknown) =>
  new AppError("VALIDATION_ERROR", "Некорректные данные запроса.", details);

export const rateLimited = () =>
  new AppError("RATE_LIMITED", "Слишком много запросов, попробуй позже.");

/** Превращает любую ошибку в JSON-ответ. Неизвестные ошибки не раскрываем. */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { code: error.code, message: error.message, details: error.details },
      { status: error.status },
    );
  }

  console.error("[api] необработанная ошибка:", error);

  return Response.json(
    { code: "INTERNAL_ERROR", message: "Внутренняя ошибка сервера." },
    { status: 500 },
  );
}
