import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-xl font-semibold">Ничего нет по этой ссылке</h1>
      <p className="text-sm text-muted">
        Заметка или папка не существует, была удалена — или это приватная
        заметка, доступная только владельцу.
      </p>
      <Link href="/" className="text-sm underline underline-offset-4 hover:text-foreground">
        На главную
      </Link>
    </main>
  );
}
