import { askNotes } from "@/domain/ask";
import { authedJson } from "@/lib/api";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { askSchema, parseBody } from "@/lib/validation";

/**
 * POST /api/ask — вопрос к своим заметкам.
 *
 * POST, а не GET с параметром, как у поиска: вопрос длиннее запроса и попал
 * бы в логи прокси целиком, а это личный текст. Кешировать его всё равно
 * нечем — ответ зависит от содержимого заметок.
 *
 * Отказ провайдера не превращается в ошибку: домен вернёт найденные заметки
 * с answer: null, и клиент покажет их без пересказа.
 */
export async function POST(request: Request) {
  return authedJson(
    request,
    async (user) => {
      const { q } = await parseBody(request, askSchema);
      return askNotes(user.id, q);
    },
    RATE_LIMITS.ask,
  );
}
