import type { NextRequest } from "next/server";

import { handlers } from "@/lib/auth";
import { vkRequestContext } from "@/lib/auth/vk-id";
import { AppError } from "@/lib/errors";
import { clientIp, consume } from "@/lib/rate-limit";

/**
 * Точка входа открыта всем, поэтому у неё собственный лимит:
 * 30 обращений в минуту с адреса. Обычному входу хватает трёх-четырёх
 * (signin → провайдер → callback → session), перебору — нет.
 */
const AUTH_RATE_LIMIT = { capacity: 30, refillMs: 60_000 };

/**
 * VK ID возвращает device_id query-параметром на этот callback, а затем
 * требует его же в теле запроса к токен-эндпоинту. Auth.js такие параметры
 * не пробрасывает, поэтому кладём device_id в AsyncLocalStorage — оттуда
 * его достаёт customFetch в src/lib/auth/vk-id.ts.
 *
 * Для остальных провайдеров обёртка ничего не меняет.
 */
function withVkDeviceId(handler: (request: NextRequest) => Promise<Response>) {
  return async (request: NextRequest) => {
    try {
      consume(`auth:${clientIp(request)}`, AUTH_RATE_LIMIT);
    } catch (error) {
      if (error instanceof AppError) {
        return Response.json({ code: error.code, message: error.message }, {
          status: error.status,
        });
      }
      throw error;
    }

    const deviceId =
      new URL(request.url).searchParams.get("device_id") ?? undefined;
    return vkRequestContext.run({ deviceId }, () => handler(request));
  };
}

export const GET = withVkDeviceId(handlers.GET);
export const POST = withVkDeviceId(handlers.POST);
