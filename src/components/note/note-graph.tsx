"use client";

import { NetworkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { GraphCanvas } from "@/components/graph/graph-canvas";
import { apiFetch } from "@/lib/api-client";
import type { Graph } from "@/lib/graph";

/**
 * Карта вокруг открытой заметки.
 *
 * То же, что страница /graph, только вырезка на два шага и без тумблеров:
 * здесь вопрос не «как устроена база», а «с чем связана вот эта заметка».
 * Слоёв два — ссылки и похожие по смыслу; папки выключены, потому что через
 * узел папки двумя шагами притянулось бы всё её содержимое (см. домен).
 *
 * Похожие здесь не дублируют список «Похожие заметки» ниже: список плоский,
 * а карта на два шага показывает, похожи ли найденные между собой.
 *
 * Запрос уходит только по нажатию, а не при открытии заметки. Полоса связей
 * рядом грузится всегда, потому что она одна строка и почти ничего не стоит;
 * окрестность же считается по всему графу владельца и досчитывает отставшие
 * векторы — платить за это при каждом открытии редактора незачем.
 */

/** Высота холста. Достаточно, чтобы разглядеть десяток узлов, и не больше. */
const CANVAS_HEIGHT = "h-56";

export function NoteGraph({ noteId }: { noteId: string }) {
  /**
   * Всё состояние хранится не флагом, а идентификатором заметки, к которой
   * оно относится. Переход к другой заметке тогда сам закрывает карту и
   * забывает ошибку — сбрасывать их эффектом не приходится, а именно такой
   * сброс вызывает каскадный рендер, на который справедливо ругается eslint.
   * Тот же приём, что в note-connections.tsx.
   */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ noteId: string; graph: Graph } | null>(
    null,
  );

  const open = openFor === noteId;
  const failed = failedFor === noteId;

  useEffect(() => {
    if (!open || loaded?.noteId === noteId) return;

    const controller = new AbortController();

    void apiFetch<Graph>(`/api/notes/${noteId}/graph`, {
      signal: controller.signal,
    })
      .then((graph) => setLoaded({ noteId, graph }))
      .catch(() => setFailedFor(noteId));

    return () => controller.abort();
  }, [loaded, noteId, open]);

  const graph = loaded?.noteId === noteId ? loaded.graph : null;

  return (
    <section
      aria-label="Карта связей заметки"
      className="shrink-0 border-b px-3 py-2 sm:px-4"
    >
      <button
        type="button"
        onClick={() => setOpenFor(open ? null : noteId)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      >
        <NetworkIcon />
        {open ? "Скрыть карту" : "Карта связей"}
      </button>

      {open && (
        <div className="mt-2">
          {failed ? (
            <p className="text-xs text-muted-foreground">
              Карту построить не удалось.
            </p>
          ) : !graph ? (
            <p role="status" className="text-xs text-muted-foreground">
              Строю карту…
            </p>
          ) : graph.edges.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              У этой заметки пока нет связей: ни ссылок, ни близких по смыслу.
              Сошлись на другую заметку через <code>[[</code> — и она появится
              здесь.
            </p>
          ) : (
            <GraphCanvas
              nodes={graph.nodes}
              edges={graph.edges}
              rootId={noteId}
              className={`w-full rounded-md border ${CANVAS_HEIGHT}`}
            />
          )}
        </div>
      )}
    </section>
  );
}
