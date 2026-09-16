"use client";

import { useEffect, useMemo, useState } from "react";

// Только тип: импорт значения из src/domain утянул бы в браузерный бандл
// всю цепочку до драйвера Postgres. Типы стираются при компиляции.
import type { SimilarEdges } from "@/domain/graph";
import { apiFetch } from "@/lib/api-client";
import {
  buildGraph,
  GRAPH_NODE_LIMIT,
  limitNodes,
  splitIsolated,
  type GraphData,
  type GraphLinkRow,
} from "@/lib/graph";

import { GraphCanvas } from "./graph-canvas";
import { GraphList } from "./graph-list";
import { useGraphLayers } from "./use-graph-layers";

/**
 * Карта связей целиком: холст, слои и фильтр.
 *
 * Граф собирается здесь, на клиенте, из тех же строк, что пришли с сервера.
 * Иначе каждый тумблер означал бы поход на сервер за уже имеющимися
 * данными — а сборка чистая и стоит миллисекунды (src/lib/graph.ts).
 *
 * Исключение — слой похожих: его строки на сервере и остаются, пока их
 * не попросят. Это полный перебор векторов, и платить за него при каждом
 * открытии страницы незачем.
 *
 * Выбранные слои переживают уход со страницы — см. use-graph-layers.ts.
 * Клик по узлу уводит на заметку, и без этого возврат на карту означал бы
 * переключать тумблеры заново каждый раз.
 */

export function GraphView({
  data,
  semanticEnabled,
}: {
  data: GraphData;
  /**
   * Готов ли смысловой слой вообще. Считается на сервере: клиенту незачем
   * знать, как это выясняется, — так же, как с режимом ответа в оболочке.
   */
  semanticEnabled: boolean;
}) {
  const [layers, setLayers] = useGraphLayers();
  const [query, setQuery] = useState("");

  const showFolders = layers.folders;
  const showIsolated = layers.isolated;

  /**
   * Сохранённое «похожие включены» ничего не значит там, где смыслового слоя
   * нет: тумблера не будет, а включённый слой остался бы без выключателя.
   * Поэтому в хранилище лежит то, что человек выбрал, а на карту идёт то,
   * что эта установка вообще умеет.
   */
  const showSimilar = layers.similar && semanticEnabled;

  /** null — ещё не запрашивали. Пустой массив — запросили, не нашлось. */
  const [similar, setSimilar] = useState<GraphLinkRow[] | null>(null);
  const [similarFailed, setSimilarFailed] = useState(false);

  useEffect(() => {
    // Один раз за жизнь страницы: пары не меняются, пока не изменятся
    // тексты, а ради этого страницу всё равно перезагрузят.
    if (!showSimilar || similar !== null) return;

    const controller = new AbortController();

    void apiFetch<SimilarEdges>("/api/graph/similar", {
      signal: controller.signal,
    })
      .then((result) => setSimilar(result.pairs))
      .catch(() => setSimilarFailed(true));

    return () => controller.abort();
  }, [showSimilar, similar]);

  const { nodes, edges, isolatedCount, omitted } = useMemo(() => {
    const built = buildGraph(
      { ...data, similar: similar ?? [] },
      { folders: showFolders, similar: showSimilar },
    );

    const split = splitIsolated(built);

    // Одиночек подмешиваем к связанным, а не рисуем отдельно: они часть
    // той же картины, просто по краям.
    const base = showIsolated
      ? { nodes: [...split.graph.nodes, ...split.isolated], edges: split.graph.edges }
      : split.graph;

    const limited = limitNodes(base, GRAPH_NODE_LIMIT);

    return {
      nodes: limited.graph.nodes,
      edges: limited.graph.edges,
      isolatedCount: split.isolated.length,
      omitted: limited.omitted,
    };
  }, [data, showFolders, showIsolated, showSimilar, similar]);

  /**
   * Что подсвечено фильтром. null — фильтра нет: это не то же самое,
   * что «не нашлось ничего», и гасить в этом случае нечего.
   */
  const matched = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ru");
    if (!needle) return null;

    return new Set(
      nodes
        .filter((node) => node.title.toLocaleLowerCase("ru").includes(needle))
        .map((node) => node.id),
    );
  }, [nodes, query]);

  const empty = nodes.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2 text-xs">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Найти на карте"
          aria-label="Найти заметку на карте"
          className="h-7 w-44 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />

        <Layer
          checked={showFolders}
          onChange={(value) => setLayers({ folders: value })}
          label="Папки"
        />

        {/* Тумблера нет совсем, когда слой не на чём построить: выключенный
            переключатель, который нельзя включить, объяснял бы меньше,
            чем его отсутствие. */}
        {semanticEnabled && (
          <Layer
            checked={showSimilar}
            onChange={(value) => setLayers({ similar: value })}
            label="Похожие по смыслу"
          />
        )}

        <Layer
          checked={showIsolated}
          onChange={(value) => setLayers({ isolated: value })}
          label={`Без связей${isolatedCount > 0 ? ` (${isolatedCount})` : ""}`}
        />

        {showSimilar && similar === null && !similarFailed && (
          <span role="status" className="text-muted-foreground">
            Считаю похожие…
          </span>
        )}

        {similarFailed && (
          <span className="text-muted-foreground">
            Похожие посчитать не удалось
          </span>
        )}

        {omitted > 0 && (
          <span className="text-muted-foreground">
            Не поместилось: {omitted}
          </span>
        )}

        {matched?.size === 0 && (
          <span className="text-muted-foreground">Ничего не нашлось</span>
        )}
      </div>

      {empty ? (
        <p className="flex-1 p-4 text-sm text-muted-foreground">
          Показывать нечего. Карта появится, когда заметки начнут ссылаться
          друг на друга или лягут по папкам.
        </p>
      ) : (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          matched={matched}
          className="min-h-0 w-full flex-1"
        />
      )}

      <details className="shrink-0 border-t px-4 py-3">
        {/* Список, а не подпись под холстом: для скринридера он
            единственный способ прочитать карту, а с клавиатуры —
            единственный способ дойти до заметки. */}
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Те же связи списком
        </summary>

        <div className="mt-3 max-h-64 overflow-y-auto">
          <GraphList nodes={nodes} edges={edges} matched={matched} />
        </div>
      </details>
    </div>
  );
}

function Layer({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-current"
      />
      {label}
    </label>
  );
}
