import { createAttachment } from "@/domain/attachments";
import { authedJson } from "@/lib/api";
import { notFound, uploadRejected } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { LIMITS, parseResourceId } from "@/lib/validation";

/**
 * POST /api/notes/:noteId/attachments — загрузка файла в заметку.
 *
 * multipart/form-data, поле `file`. Ответ — метаданные и готовый адрес,
 * который редактор вставляет в текст.
 */

/**
 * Запас на служебную обвязку multipart: граница, заголовки части, имя файла.
 * Килобайта хватает с избытком, а точная проверка размера всё равно идёт
 * дальше, по фактическим байтам.
 */
const MULTIPART_OVERHEAD = 1024;

export async function POST(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]/attachments">,
) {
  return authedJson(
    request,
    async (user) => {
      const { noteId } = await context.params;
      const id = parseResourceId(noteId);
      if (!id) throw notFound();

      // Отказ по заголовку — до чтения тела. Иначе присланные «на пробу»
      // полгигабайта успели бы полностью оказаться в памяти процесса
      // прежде, чем мы решили бы их отвергнуть.
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > LIMITS.attachmentMaxBytes + MULTIPART_OVERHEAD) {
        throw uploadRejected(
          `Файл больше ${Math.round(LIMITS.attachmentMaxBytes / 1024 / 1024)} МБ.`,
        );
      }

      const form = await request.formData().catch(() => null);
      const file = form?.get("file");

      if (!(file instanceof File)) {
        throw uploadRejected("Файл не передан.");
      }

      return createAttachment(user.id, id, {
        name: file.name,
        type: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
    },
    RATE_LIMITS.mutation,
  );
}
