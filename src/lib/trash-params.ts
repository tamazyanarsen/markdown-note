import { notFound } from "./errors";
import { parseResourceId } from "./validation";

/**
 * Разбор пути /api/trash/:kind/:id.
 *
 * Вид ресурса приходит сегментом адреса, а не телом запроса: у DELETE тела
 * нет, а два отдельных дерева роутов ради одного слова означали бы четыре
 * почти одинаковых файла вместо двух.
 *
 * Чужое значение — 404, а не 400, как и невалидный UUID: по таблице ошибок
 * из документа несуществующий ресурс и мусор в ссылке для клиента
 * неразличимы.
 */
export type TrashKind = "notes" | "folders";

export function parseTrashParams(kind: string, id: string): {
  kind: TrashKind;
  id: string;
} {
  if (kind !== "notes" && kind !== "folders") throw notFound();

  const parsed = parseResourceId(id);
  if (!parsed) throw notFound();

  return { kind, id: parsed };
}
