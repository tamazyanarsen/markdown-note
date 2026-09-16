import { getSimilarEdges } from "@/domain/graph";
import { authedJson } from "@/lib/api";
import { RATE_LIMITS } from "@/lib/rate-limit";

/**
 * GET /api/graph/similar
 *
 * Слой смысловой близости для карты связей. Отдельно от страницы, потому
 * что включается тумблером и только по желанию: это полный перебор
 * векторов плюс возможная переиндексация через внешний API.
 *
 * Профиль лимита — semanticSearch, как у всего, что может дёрнуть модель
 * за деньги. Запрос уходит по щелчку человека, не чаще.
 */
export async function GET(request: Request) {
  return authedJson(
    request,
    async (user) => getSimilarEdges(user.id),
    RATE_LIMITS.semanticSearch,
  );
}
