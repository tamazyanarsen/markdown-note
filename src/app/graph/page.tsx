import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { GraphView } from "@/components/graph/graph-view";
import { getGraphData } from "@/domain/graph";
import { isSemanticEnabled } from "@/lib/embeddings";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Карта связей",
};

/**
 * Карта связей между заметками.
 *
 * Строки собираются здесь, на сервере, и уходят в клиентскую обвязку
 * пропсами — так же, как дерево в боковой панели (loadOwnerTree в AppShell).
 * Запроса из useEffect нет намеренно: данные нужны ровно один раз при
 * открытии, и клиентская загрузка добавила бы к первому кадру пустой экран.
 */
export default async function GraphPage() {
  const user = await getCurrentUser();

  if (!user) redirect("/signin");
  if (!user.isApproved) redirect("/pending");

  const data = await getGraphData(user.id);

  return (
    <AppShell user={user}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="shrink-0 border-b px-4 py-3">
          <h1 className="font-heading text-lg font-semibold">Карта связей</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Кружки — заметки, квадраты — папки. Размер узла — сколько у него
            связей. Наведи, чтобы подсветить соседей; колесо или щипок меняют
            масштаб, узел можно перетащить.
          </p>
        </header>

        {/* Переменные окружения читаются на сервере: клиенту достаётся
            готовый ответ «есть смысловой слой или нет», а не способ это
            выяснить. Так же устроен режим ответа в оболочке. */}
        <GraphView data={data} semanticEnabled={isSemanticEnabled()} />
      </div>
    </AppShell>
  );
}
