import { redirect } from "next/navigation";

import { SignOutButton } from "@/components/sign-out-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Доступ ещё не открыт</CardTitle>
          <CardDescription>
            Аккаунт создан, но не одобрен. Попроси владельца сервиса открыть
            доступ — для этого нужен твой идентификатор:
          </CardDescription>
        </CardHeader>

        <CardContent>
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
            {user.id}
          </code>
        </CardContent>

        <CardFooter>
          <SignOutButton className="text-muted-foreground" />
        </CardFooter>
      </Card>
    </main>
  );
}
