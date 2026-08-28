import { toErrorResponse } from "./errors";
import {
  clientIp,
  consume,
  RATE_LIMITS,
  type RateLimitOptions,
} from "./rate-limit";
import { requireUser, type CurrentUser } from "./session";

/**
 * Обвязка для route handlers.
 *
 * Handler занимается только HTTP: аутентификация, лимиты, коды ответа.
 * Проверки владения и доменные правила живут в src/domain.
 */
export async function authedJson<T>(
  request: Request,
  run: (user: CurrentUser) => Promise<T>,
  limit: RateLimitOptions = RATE_LIMITS.mutation,
): Promise<Response> {
  try {
    // По IP — до обращения к базе: гость с перебором не должен
    // заставлять нас читать сессию на каждый запрос.
    consume(`ip:${clientIp(request)}`, limit);

    const user = await requireUser();
    consume(`user:${user.id}`, limit);

    const data = await run(user);
    return Response.json(data ?? { ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
