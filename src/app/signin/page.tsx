import { redirect } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-6">
      {errorText && (
        <Alert variant="destructive">
          <AlertTitle>Вход не удался</AlertTitle>
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">md-note</CardTitle>
          <CardDescription>Заметки в markdown с публичными ссылками.</CardDescription>
        </CardHeader>

        <CardContent>
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
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
                  <Button type="submit" variant="outline" size="lg" className="w-full">
                    Войти через {provider.name}
                  </Button>
                </form>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
