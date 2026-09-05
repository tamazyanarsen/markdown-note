import { getAttachmentForViewer } from "@/domain/attachments";
import { toErrorResponse } from "@/lib/errors";
import { clientIp, consume, RATE_LIMITS } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import {
  contentDisposition,
  isInlineImage,
  readAttachmentFile,
  type AllowedMimeType,
} from "@/lib/uploads";
import { parseResourceId } from "@/lib/validation";

/**
 * GET /api/files/:attachmentId — отдача вложения.
 *
 * Единственная ручка API без authedJson, и намеренно: вложение публичной
 * заметки обязано открываться гостю — иначе картинка в опубликованной заметке
 * ломалась бы у всех, кроме автора. Права проверяет доменный слой по заметке,
 * здесь остаётся только HTTP.
 *
 * Ответ 404 во всех случаях отказа. 403 подтвердил бы, что файл существует —
 * то же правило, что и у самих заметок.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/files/[attachmentId]">,
) {
  try {
    // Гостю сессию не читаем до лимита: перебор UUID не должен стоить нам
    // похода в базу на каждую попытку.
    consume(`ip:${clientIp(request)}`, RATE_LIMITS.publicRead);

    const { attachmentId } = await context.params;
    const id = parseResourceId(attachmentId);
    if (!id) return new Response(null, { status: 404 });

    const viewer = await getCurrentUser();
    const attachment = await getAttachmentForViewer(id, viewer?.id ?? null);
    if (!attachment) return new Response(null, { status: 404 });

    const mimeType = attachment.mimeType as AllowedMimeType;
    const bytes = await readAttachmentFile(
      attachment.ownerId,
      attachment.id,
      mimeType,
    );

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(bytes.byteLength),
        // Картинка показывается в заметке, всё остальное скачивается:
        // открывать чужой pdf на своём домене незачем.
        "Content-Disposition": contentDisposition(
          attachment.filename,
          isInlineImage(attachment.mimeType),
        ),
        // immutable — потому что байты по этому адресу не меняются никогда:
        // правка вложения означает новую загрузку и новый UUID.
        //
        // private, хотя заметка может быть публичной: заметку можно вернуть
        // в private, а до копии, осевшей в общем кеше, мы уже не дотянемся.
        // Браузер посетителя закеширует и так, а он этот файл и без того видел.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
