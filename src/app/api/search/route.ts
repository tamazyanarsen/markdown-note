import { searchNotes } from "@/domain/search";
import { authedJson } from "@/lib/api";
import { validationError } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { searchQuerySchema } from "@/lib/validation";

/**
 * GET /api/search?q=…&mode=fts|hybrid
 *
 * Два режима вместо одного, потому что у них разная цена. Палитра шлёт fts
 * на каждое нажатие клавиши — он локальный и бесплатный, список появляется
 * сразу. hybrid уходит после паузы в наборе: он добавляет смысловой слой,
 * но стоит вызова внешнего API.
 *
 * Ищем только по своим заметкам. Чужие public-заметки сюда не попадают:
 * общего каталога в сервисе нет, ими делятся ссылкой адресно.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const parsed = searchQuerySchema.safeParse({
    q: searchParams.get("q") ?? "",
    // Пустой параметр — это «не задан», иначе z.enum споткнётся об "".
    mode: searchParams.get("mode") || undefined,
  });

  // Лимит выбираем по режиму, поэтому разбираем параметры до authedJson.
  const limit =
    parsed.success && parsed.data.mode === "hybrid"
      ? RATE_LIMITS.semanticSearch
      : RATE_LIMITS.search;

  return authedJson(
    request,
    async (user) => {
      if (!parsed.success) throw validationError("Некорректный поисковый запрос");

      return searchNotes(user.id, parsed.data.q, { mode: parsed.data.mode });
    },
    limit,
  );
}
