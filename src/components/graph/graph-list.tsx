import Link from "next/link";

import type { GraphEdge, GraphNode } from "@/lib/graph";

/**
 * Тот же граф списком.
 *
 * Холст для скринридера — пустой прямоугольник, и никакие aria-атрибуты
 * этого не меняют: там нет ни элементов, ни текста, ни фокуса. Поэтому
 * содержимое карты продублировано разметкой — заметки и то, с чем каждая
 * связана. Это же единственный способ дойти до заметки с клавиатуры.
 *
 * Список не спрятан визуально: он полезен и зрячему — по нему можно искать
 * глазами и он не требует попадать мышью в мелкий кружок.
 */
export function GraphList({
  nodes,
  edges,
  matched,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Фильтр по заголовку: null — фильтра нет, показываем всё. */
  matched?: ReadonlySet<string> | null;
}) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  /** Соседи каждого узла — ненаправленно: связь есть связь. */
  const neighbors = new Map<string, Set<string>>();

  const add = (from: string, to: string) => {
    const set = neighbors.get(from);
    if (set) set.add(to);
    else neighbors.set(from, new Set([to]));
  };

  for (const edge of edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }

  // Сначала самые связанные: на карте они в центре, и в списке должны
  // быть наверху. Порядок при равных степенях — по заголовку, чтобы
  // список не переставлялся между открытиями.
  // Фильтр здесь именно отсекает, а не гасит, как на холсте: в списке
  // нечего разглядывать вокруг найденного, а прокручивать мимо
  // отфильтрованного пришлось бы руками.
  const ordered = [...nodes]
    .filter((node) => !matched || matched.has(node.id))
    .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title, "ru"));

  return (
    // Имя обязательно: на странице есть второй список — дерево в боковой
    // панели, — и без подписи скринридер объявит оба одинаково.
    <ul aria-label="Связи заметок" className="space-y-2 text-sm">
      {ordered.map((node) => (
        <li key={node.id}>
          <span className="font-medium">
            {node.kind === "note" ? (
              <Link href={`/n/${node.id}`} className="hover:underline">
                {node.title}
              </Link>
            ) : (
              // Папка на карте — узел, но не страница: её содержимое
              // показывает дерево слева.
              <>папка «{node.title}»</>
            )}
          </span>

          <span className="text-muted-foreground">
            {" — "}
            {[...(neighbors.get(node.id) ?? [])]
              .map((id) => byId.get(id)?.title)
              .filter(Boolean)
              .join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}
