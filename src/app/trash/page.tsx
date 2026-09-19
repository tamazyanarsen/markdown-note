import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { TrashList } from "@/components/trash/trash-list";
import { listTrash, TRASH_RETENTION_DAYS } from "@/domain/trash";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Корзина",
};

/**
 * Корзина: что удалено, но ещё не исчезло.
 *
 * Список собирается здесь, на сервере, и уходит в клиентскую обвязку
 * пропсами — так же, как дерево в боковой панели и строки карты.
 * Тот же вызов заодно подчищает просроченное (listTrash → purgeExpired),
 * поэтому открытие страницы и есть момент автоочистки.
 */
export default async function TrashPage() {
  const user = await getCurrentUser();

  if (!user) redirect("/signin");
  if (!user.isApproved) redirect("/pending");

  const items = await listTrash(user.id);

  return (
    <AppShell user={user}>
      <TrashList items={items} retentionDays={TRASH_RETENTION_DAYS} />
    </AppShell>
  );
}
