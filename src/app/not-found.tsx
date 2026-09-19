import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Единственная страница, которую Next хотел бы отрендерить на сборке.
 *
 * С nonce-политикой это не годится: nonce рождается на запрос, а в готовый
 * html его подставить уже некуда — скрипты остались бы без него и, из-за
 * 'strict-dynamic', не выполнились бы вовсе. connection() переводит страницу
 * в рендер на запрос; остальные страницы и так динамические, потому что
 * читают сессию.
 */
export default async function NotFound() {
  await connection();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ничего нет по этой ссылке</CardTitle>
          <CardDescription>
            Заметка или папка не существует, была удалена — или это приватная
            заметка, доступная только владельцу.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ArrowLeftIcon />
              На главную
            </Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
