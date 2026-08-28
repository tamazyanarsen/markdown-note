import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentUser } from "@/lib/session";

/**
 * Вход создаёт пользователя, но доступ к дереву открывается только
 * после одобрения. Иначе одобрять было бы некого: у VK-пользователя
 * нет email, по которому его можно занести в ALLOWED_EMAILS заранее.
 */
export default async function PendingPage() {
  const user = await getCurrentUser();

  if (!user) redirect("/signin");
  if (user.isApproved) redirect("/");

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Доступ ещё не открыт</h1>
      <p className="text-sm text-muted">
        Аккаунт создан, но не одобрен. Попроси владельца сервиса открыть доступ —
        для этого нужен твой идентификатор:
      </p>
      <code className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs break-all">
        {user.id}
      </code>
      <SignOutButton />
    </main>
  );
}
