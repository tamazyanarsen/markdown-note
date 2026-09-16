/**
 * Граф связей между заметками: сборка, степени узлов, подграфы.
 *
 * Здесь нет ни базы, ни React, ни холста — только превращение плоских
 * списков в узлы и рёбра. Всё, что рисуется на экране, выводится из
 * результата этих функций, поэтому их можно проверить обычным юнит-тестом,
 * а не скриншотом.
 *
 * Рёбра двух видов, и это главное решение фичи. Ссылку поставил человек,
 * принадлежность папке — структура дерева. Они не смешиваются в один вид:
 * то же правило, по которому обратные ссылки и похожие заметки живут
 * в разных списках (src/domain/connections.ts). Слой папок нужен потому,
 * что на реальной базе большинство заметок ни на что не ссылается —
 * без него граф был бы облаком несвязанных точек.
 */

/**
 * Потолок на число рисуемых узлов.
 *
 * Применяется после сборки, уже на клиенте: какие узлы важнее, видно только
 * по их связям, а связи зависят от того, какие слои включены. Полторы тысячи
 * точек — это сплошная сеть, в которой глазом ничего не разобрать; заметок
 * у владельца может быть до 5000 (LIMITS.notesPerUser), так что предел
 * достижим.
 *
 * Живёт здесь, а не в доменном слое, ровно по одной причине: отсюда её может
 * импортировать клиентский компонент. Импорт значения из src/domain утянул бы
 * в браузерный бандл всю цепочку до драйвера Postgres.
 */
export const GRAPH_NODE_LIMIT = 1500;

// --- Вход: плоские строки из базы ------------------------------------------

export interface GraphNoteRow {
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: Date;
}

export interface GraphFolderRow {
  id: string;
  parentId: string | null;
  title: string;
}

export interface GraphLinkRow {
  sourceId: string;
  targetId: string;
}

export interface GraphData {
  notes: GraphNoteRow[];
  folders: GraphFolderRow[];
  links: GraphLinkRow[];
  /**
   * Пары близких по смыслу заметок. Приходят отдельным запросом и только
   * по включённому тумблеру: считать их дорого, а без ключа к модели
   * их нет вовсе.
   */
  similar?: GraphLinkRow[];
}

// --- Выход: то, что уходит на холст ----------------------------------------

export type GraphNodeKind = "note" | "folder";

/**
 * Откуда взялось ребро — и это же задаёт, как оно нарисовано.
 *
 * link — человек поставил ссылку в тексте. folder — заметка лежит в папке.
 * similar — косинус решил, что тексты близки. Три разных утверждения,
 * и смешивать их в одну линию нельзя: «ты сам это связал» и «возможно,
 * связано» — не одно и то же (то же правило в src/domain/connections.ts).
 */
export type GraphEdgeKind = "link" | "folder" | "similar";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  title: string;
  /**
   * Папка, в которой лежит узел: у заметки своя, у папки — родительская.
   * Ею красится узел, поэтому заметка и её папка одного цвета.
   */
  folderId: string | null;
  /**
   * Сколько рёбер касается узла. Задаёт его размер — та самая величина,
   * которой в облаке тегов был кегль.
   */
  degree: number;
}

export interface GraphEdge {
  /** Идентификаторы, а не ссылки на объекты: d3-force разрешит их сам. */
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface BuildGraphOptions {
  /** Показывать ли папки отдельными узлами. */
  folders?: boolean;
  /** Показывать ли рёбра смысловой близости. По умолчанию нет. */
  similar?: boolean;
}

/**
 * Собирает граф из строк базы.
 *
 * Ссылка на заметку, которой нет в выборке, молча выпадает: список заметок
 * уже отфильтрован по владельцу и архиву, и ребро в отсутствующий узел
 * сломало бы раскладку (d3-force бросает на неизвестном идентификаторе).
 *
 * Взаимная пара ссылок A→B и B→A остаётся двумя рёбрами. Склеивать их
 * незачем: на холсте они лягут одной линией с двумя стрелками, а степень
 * обоих узлов честно вырастет на два — взаимная ссылка и есть связь вдвое
 * более прочная, чем односторонняя.
 */
export function buildGraph(
  data: GraphData,
  options: BuildGraphOptions = {},
): Graph {
  const withFolders = options.folders ?? true;

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const note of data.notes) {
    nodes.set(note.id, {
      id: note.id,
      kind: "note",
      title: note.title,
      folderId: note.folderId,
      degree: 0,
    });
  }

  if (withFolders) {
    for (const folder of data.folders) {
      nodes.set(folder.id, {
        id: folder.id,
        kind: "folder",
        title: folder.title,
        // Папка красится по родителю: так ветка дерева остаётся одноцветной.
        folderId: folder.parentId,
        degree: 0,
      });
    }
  }

  for (const link of data.links) {
    if (!nodes.has(link.sourceId) || !nodes.has(link.targetId)) continue;
    edges.push({ source: link.sourceId, target: link.targetId, kind: "link" });
  }

  if (options.similar && data.similar) {
    // Пары приходят уже свёрнутыми: «похоже» — отношение взаимное,
    // и рисовать его дважды значило бы удваивать степень обоих узлов.
    for (const pair of data.similar) {
      if (!nodes.has(pair.sourceId) || !nodes.has(pair.targetId)) continue;
      edges.push({
        source: pair.sourceId,
        target: pair.targetId,
        kind: "similar",
      });
    }
  }

  if (withFolders) {
    // Папка к родительской папке — скелет дерева.
    for (const folder of data.folders) {
      if (!folder.parentId || !nodes.has(folder.parentId)) continue;
      edges.push({ source: folder.id, target: folder.parentId, kind: "folder" });
    }

    // Заметка к своей папке. Направление от заметки к папке, как у ссылки
    // от источника к цели: стрелки на слое папок не рисуются, но порядок
    // концов должен быть предсказуемым.
    for (const note of data.notes) {
      if (!note.folderId || !nodes.has(note.folderId)) continue;
      edges.push({ source: note.id, target: note.folderId, kind: "folder" });
    }
  }

  for (const edge of edges) {
    nodes.get(edge.source)!.degree += 1;
    nodes.get(edge.target)!.degree += 1;
  }

  return { nodes: [...nodes.values()], edges };
}

/**
 * Делит узлы на связанные и одиночные.
 *
 * Одиночные — те, которых не касается ни одно ребро. При включённых папках
 * это только заметки, лежащие в корне и ни на что не ссылающиеся; при
 * выключенных — обычно большая часть базы. Прятать их нужно не ради
 * производительности, а ради читаемости: сотня точек по краю экрана
 * не несёт никакого смысла и мешает разглядеть то, что связано.
 *
 * Рёбра не фильтруются: по определению ни одно из них не касается
 * одиночного узла.
 */
export function splitIsolated(graph: Graph): {
  graph: Graph;
  isolated: GraphNode[];
} {
  const connected: GraphNode[] = [];
  const isolated: GraphNode[] = [];

  for (const node of graph.nodes) {
    (node.degree > 0 ? connected : isolated).push(node);
  }

  return { graph: { nodes: connected, edges: graph.edges }, isolated };
}

/**
 * Вырез по списку узлов: рёбра с обрубленным концом выбрасываются,
 * степени пересчитываются по тому, что осталось.
 *
 * Пересчёт обязателен: узел на границе выреза должен выглядеть так, как
 * он выглядит здесь, а не так, как в целом графе, — иначе на локальном
 * графе заметки соседи раздувались бы до размеров, ничем на экране
 * не подтверждённых.
 */
function subgraph(graph: Graph, kept: ReadonlySet<string>): Graph {
  const edges = graph.edges.filter(
    (edge) => kept.has(edge.source) && kept.has(edge.target),
  );

  const degrees = new Map<string, number>();

  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }

  const nodes = graph.nodes
    .filter((node) => kept.has(node.id))
    .map((node) => ({ ...node, degree: degrees.get(node.id) ?? 0 }));

  return { nodes, edges };
}

/**
 * Оставляет не больше limit самых связанных узлов.
 *
 * Страховка от разросшейся базы: заметок у одного владельца может быть до
 * 5000 (LIMITS.notesPerUser), и рисовать их все значило бы отдать клиенту
 * лишние сотни килобайт ради сплошного месива на экране. Отбор по степени:
 * если показывать не всё, то показывать надо сердцевину графа, а не
 * случайные узлы. Сколько отброшено — возвращается наружу, чтобы обрезка
 * не выглядела полной картиной.
 */
export function limitNodes(
  graph: Graph,
  limit: number,
): { graph: Graph; omitted: number } {
  if (graph.nodes.length <= limit) return { graph, omitted: 0 };

  const kept = [...graph.nodes]
    // При равных степенях порядок фиксируем по id: иначе состав графа
    // прыгал бы между одинаковыми запросами. Так же сравнивает узлы
    // дерева compareNodes в src/db/queries/tree.ts.
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, limit);

  return {
    graph: subgraph(graph, new Set(kept.map((node) => node.id))),
    omitted: graph.nodes.length - limit,
  };
}

/**
 * Подграф вокруг узла: он сам и всё, до чего можно дойти за radius шагов.
 *
 * Обход ненаправленный — «на меня ссылаются» это такая же связь, как
 * «я ссылаюсь». Нужен для локального графа на странице заметки: там
 * показывается окрестность, а не вся база.
 */
export function neighborhood(
  graph: Graph,
  rootId: string,
  radius: number,
): Graph {
  if (!graph.nodes.some((node) => node.id === rootId)) {
    return { nodes: [], edges: [] };
  }

  const adjacency = new Map<string, string[]>();

  const connect = (from: string, to: string) => {
    const neighbors = adjacency.get(from);
    if (neighbors) neighbors.push(to);
    else adjacency.set(from, [to]);
  };

  for (const edge of graph.edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const reached = new Set([rootId]);
  let frontier = [rootId];

  for (let step = 0; step < radius; step += 1) {
    const next: string[] = [];

    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (reached.has(neighbor)) continue;
        reached.add(neighbor);
        next.push(neighbor);
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return subgraph(graph, reached);
}

// --- Детерминированная случайность -----------------------------------------

/**
 * Генератор псевдослучайных чисел от строкового зерна (mulberry32 поверх
 * хеша FNV-1a).
 *
 * Нужен вместо Math.random, чтобы раскладка одного и того же графа
 * выходила одинаковой: у d3-force есть simulation.randomSource() ровно для
 * этого. Без него граф перестраивался бы заново на каждое открытие страницы
 * — заметка каждый раз оказывалась бы в новом месте, и узнать свою карту
 * было бы невозможно. Заодно это делает раскладку проверяемой тестом.
 */
export function createRandom(seed: string): () => number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    // FNV-простое 16777619 через сдвиги: умножение переполнило бы
    // мантиссу double и потеряло младшие биты.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }

  let state = hash;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
