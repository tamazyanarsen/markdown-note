import { getNoteConnections } from "@/domain/connections";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { parseResourceId } from "@/lib/validation";

/**
 * GET /api/notes/:noteId/connections
 *
 * Обратные ссылки и похожие заметки одним ответом — их показывает одна
 * панель под редактором.
 *
 * Профиль лимита обычный, а не semanticSearch, хотя запрос изредка может
 * дёрнуть внешний API на реиндексации отставших векторов. Число таких
 * вызовов зависит от того, сколько заметок правили, а не от того, сколько
 * раз открыли страницу: догнав векторы, эндпоинт перестаёт ходить в сеть.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]/connections">,
) {
  return authedJson(
    request,
    async (user) => {
      const { noteId } = await context.params;
      const id = parseResourceId(noteId);
      if (!id) throw notFound();

      return getNoteConnections(user.id, id);
    },
    RATE_LIMITS.search,
  );
}
