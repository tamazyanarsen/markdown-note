import { AsyncLocalStorage } from "node:async_hooks";

import { customFetch } from "next-auth";
import type { OAuth2Config, OAuthUserConfig } from "next-auth/providers";

/**
 * Провайдер VK ID (OAuth 2.1).
 *
 * Встроенный в Auth.js провайдер `vk` ходит в legacy-эндпоинт oauth.vk.com,
 * который VK закрывает для новых приложений. Здесь реализован актуальный
 * VK ID: id.vk.com, обязательный PKCE и device_id.
 *
 * Особенность VK ID: `device_id` приходит query-параметром на наш callback,
 * а затем обязан уйти в тело запроса к токен-эндпоинту. Auth.js не пробрасывает
 * произвольные параметры callback'а в token request, поэтому device_id
 * прокидывается через AsyncLocalStorage: его кладёт обёртка в
 * src/app/api/auth/[...nextauth]/route.ts, а забирает customFetch ниже.
 *
 * СТАТУС: не проверено на живом приложении — VK не принимает localhost
 * в redirect URI. Проверяется на этапе 8, когда появится домен.
 */

const VK_AUTHORIZATION_URL = "https://id.vk.com/authorize";
const VK_TOKEN_URL = "https://id.vk.com/oauth2/auth";
const VK_USER_INFO_URL = "https://id.vk.com/oauth2/user_info";

/** Контекст одного HTTP-запроса к /api/auth/*. */
export const vkRequestContext = new AsyncLocalStorage<{ deviceId?: string }>();

export interface VkIdProfile {
  user_id: string;
  first_name?: string;
  last_name?: string;
  avatar?: string;
  email?: string;
}

export function VKID(
  options: OAuthUserConfig<VkIdProfile> & { clientId?: string; clientSecret?: string },
): OAuth2Config<VkIdProfile> {
  return {
    id: "vk",
    name: "VK ID",
    type: "oauth",

    authorization: {
      url: VK_AUTHORIZATION_URL,
      params: { scope: "vkid.personal_info email" },
    },

    token: VK_TOKEN_URL,

    // VK ID требует PKCE; state добавляем сами — Auth.js по умолчанию
    // ограничивается pkce, а VK возвращает state в callback'е.
    checks: ["pkce", "state"],

    client: { token_endpoint_auth_method: "client_secret_post" },

    userinfo: {
      url: VK_USER_INFO_URL,
      async request({ tokens }: { tokens: { access_token?: string } }) {
        const response = await fetch(VK_USER_INFO_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: options.clientId ?? "",
            access_token: tokens.access_token ?? "",
          }),
        });

        if (!response.ok) {
          throw new Error(`VK ID user_info вернул ${response.status}`);
        }

        const payload = (await response.json()) as { user: VkIdProfile };
        return payload.user;
      },
    },

    async [customFetch](...args: Parameters<typeof fetch>) {
      const request = new Request(...args);

      // Все запросы, кроме обмена кода на токен, идут как обычно.
      if (!request.url.startsWith(VK_TOKEN_URL)) {
        return fetch(request);
      }

      const body = new URLSearchParams(await request.text());
      const deviceId = vkRequestContext.getStore()?.deviceId;
      if (deviceId) {
        body.set("device_id", deviceId);
      }

      return fetch(VK_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    },

    profile(profile) {
      return {
        id: String(profile.user_id),
        name:
          [profile.first_name, profile.last_name].filter(Boolean).join(" ") || null,
        // VK отдаёт email не всегда — колонка users.email это допускает.
        email: profile.email?.toLowerCase() ?? null,
        image: profile.avatar ?? null,
      };
    },

    style: { brandColor: "#0077FF" },

    options,
  };
}
