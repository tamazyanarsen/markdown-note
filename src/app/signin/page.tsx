import { redirect } from "next/navigation";

import { getEnabledProviders, signIn } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session";

const ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "Этот email уже привязан к другому способу входа. Войди тем же провайдером, что и в первый раз.",
  AccessDenied: "Провайдер отклонил вход.",
  Configuration: "Провайдер настроен неверно — проверь переменные окружения.",
};

export default async function SignInPage({
  searchParams,
}: PageProps<"/signin">) {
  if (await getCurrentUser()) {
    redirect("/");
  }

  const providers = getEnabledProviders();
  const { error } = await searchParams;
  const errorText =
    typeof error === "string"
      ? (ERROR_MESSAGES[error] ?? "Не удалось войти. Попробуй ещё раз.")
      : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">md-note</h1>
        <p className="mt-1 text-sm text-muted">Заметки в markdown с публичными ссылками.</p>
      </div>

      {errorText && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {errorText}
        </p>
      )}

      {providers.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">
          Ни один OAuth-провайдер не настроен. Заполни{" "}
          <code className="font-mono">AUTH_GITHUB_ID</code> и{" "}
          <code className="font-mono">AUTH_GITHUB_SECRET</code> в{" "}
          <code className="font-mono">.env</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <form
              key={provider.id}
              action={async () => {
                "use server";
                await signIn(provider.id, { redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="w-full cursor-pointer rounded-md border border-border bg-surface px-4 py-2.5 text-sm font-medium transition-colors hover:bg-border"
              >
                Войти через {provider.name}
              </button>
            </form>
          ))}
        </div>
      )}
    </main>
  );
}
