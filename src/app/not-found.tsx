import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function NotFound() {
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
