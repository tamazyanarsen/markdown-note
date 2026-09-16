import { getNoteNeighborhood } from "@/domain/graph";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { parseResourceId } from "@/lib/validation";

/**
 * GET /api/notes/:noteId/graph
 *
 * Окрестность заметки для маленькой карты на её странице.
 *
 * Отдельно от /connections, хотя обе живут под редактором: полоса связей
 * запрашивается при каждом открытии заметки, а карта — только когда её
 * развернут. Складывать их в один ответ значило бы считать окрестность
 * всем подряд ради тех, кто её не открывает.
 *
 * Профиль лимита обычный: запрос локальный, внешний API не участвует.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]/graph">,
) {
  return authedJson(
    request,
    async (user) => {
      const { noteId } = await context.params;
      const id = parseResourceId(noteId);
      if (!id) throw notFound();

      return getNoteNeighborhood(user.id, id);
    },
    RATE_LIMITS.search,
  );
}
