import { FilePlusIcon, GlobeIcon, LockIcon } from "lucide-react";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) redirect("/signin");
  if (!user.isApproved) redirect("/pending");

  return (
    <AppShell user={user}>
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-8">
        <h1 className="font-heading text-xl font-semibold">Заметки</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Выбери заметку слева или создай новую.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Hint
            icon={<FilePlusIcon />}
            title="Создание"
            text="Кнопки «Папка» и «Заметка» в боковой панели — в корне, а через меню «…» у папки — внутри неё."
          />
          <Hint
            icon={<LockIcon />}
            title="Приватность"
            text="Заметка приватна, пока её не опубликуешь: ссылка /n/<uuid> отдаёт гостю 404."
          />
          <Hint
            icon={<GlobeIcon />}
            title="Публикация"
            text="Ссылка на папку открывается всегда, но показывает только опубликованные заметки внутри."
          />
        </div>
      </div>
    </AppShell>
  );
}

function Hint({
  icon,
  title,
  text,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription>{text}</CardDescription>
      </CardContent>
    </Card>
  );
}
