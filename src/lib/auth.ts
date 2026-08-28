import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Yandex from "next-auth/providers/yandex";

import { db } from "@/db/client";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";

import { VKID } from "./auth/vk-id";

/**
 * Список email, которым вход разрешён автоматически.
 * Пусто — регистрация открыта (режим локальной разработки).
 */
const allowedEmails = new Set(
  (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

const isOpenRegistration = allowedEmails.size === 0;

// NEXT_PHASE отсекает сборку: во время next build предупреждать не о чем,
// а печаталось бы оно по разу на каждый воркер.
if (
  isOpenRegistration &&
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  console.warn(
    "[auth] ALLOWED_EMAILS пуст: зарегистрироваться сможет любой, кто нашёл сайт. " +
      "Для публичного сервера заполни ALLOWED_EMAILS в .env.",
  );
}

/**
 * Провайдер включается, только если для него заданы обе переменные окружения.
 * Так локальная разработка идёт с одним GitHub, а прод — со всеми тремя,
 * и страница входа не показывает кнопку, которая заведомо не сработает.
 */
const PROVIDER_CATALOG = [
  {
    id: "github",
    name: "GitHub",
    idEnv: "AUTH_GITHUB_ID",
    secretEnv: "AUTH_GITHUB_SECRET",
    create: (): Provider => GitHub,
  },
  {
    id: "yandex",
    name: "Яндекс",
    idEnv: "AUTH_YANDEX_ID",
    secretEnv: "AUTH_YANDEX_SECRET",
    create: (): Provider => Yandex,
  },
  {
    id: "vk",
    name: "VK ID",
    idEnv: "AUTH_VK_ID",
    secretEnv: "AUTH_VK_SECRET",
    create: (): Provider =>
      VKID({
        clientId: process.env.AUTH_VK_ID,
        clientSecret: process.env.AUTH_VK_SECRET,
      }),
  },
] as const;

function enabledProviderCatalog() {
  return PROVIDER_CATALOG.filter(
    (provider) => process.env[provider.idEnv] && process.env[provider.secretEnv],
  );
}

/** Для страницы входа: какие кнопки вообще показывать. */
export function getEnabledProviders(): Array<{ id: string; name: string }> {
  return enabledProviderCatalog().map(({ id, name }) => ({ id, name }));
}

function buildProviders(): Provider[] {
  return enabledProviderCatalog().map((provider) => provider.create());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Схема расходится с дефолтной у адаптера (uuid-ключи, citext-email,
  // display_name вместо name), поэтому передаём таблицы явно.
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any),

  // Сессии в БД: их видно и можно отозвать, в отличие от JWT.
  session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },

  providers: buildProviders(),

  pages: {
    signIn: "/signin",
    error: "/signin",
  },

  callbacks: {
    session({ session, user }) {
      session.user.id = user.id;
      session.user.isApproved =
        (user as typeof user & { isApproved?: boolean }).isApproved ?? false;
      return session;
    },
  },

  events: {
    /**
     * Вход всегда создаёт пользователя, но доступ к приложению открывается
     * только одобренным. Так у VK-пользователя без email тоже появляется
     * строка в БД, которую администратор может одобрить вручную:
     *
     *   update users set is_approved = true where id = '...';
     *
     * Обратный порядок (блокировать в колбэке signIn) даёт тупик:
     * одобрять было бы некого — строки ещё нет.
     */
    async createUser({ user }) {
      const email = user.email?.toLowerCase();
      const approved = isOpenRegistration || (!!email && allowedEmails.has(email));

      if (approved && user.id) {
        await db
          .update(users)
          .set({ isApproved: true })
          .where(eq(users.id, user.id));
      }
    },
  },
});
