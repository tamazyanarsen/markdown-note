import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/session";

export default async function HomePage() {
  const user = await getCurrentUser();

  if (!user) redirect("/signin");
  if (!user.isApproved) redirect("/pending");

  return (
    <AppShell user={user}>
      <div className="p-8">
        <h1 className="text-xl font-semibold">Заметки</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          Выбери заметку слева или создай новую. Заметка приватна, пока её не
          опубликуешь: ссылка вида <code className="font-mono">/n/&lt;uuid&gt;</code>{" "}
          отдаёт гостю 404. Ссылка на папку открывается всегда, но показывает
          только опубликованные заметки внутри.
        </p>
      </div>
    </AppShell>
  );
}
