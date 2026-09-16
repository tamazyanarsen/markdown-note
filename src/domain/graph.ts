import { loadGraphData, loadSimilarPairs } from "@/db/queries/graph";
import { isSemanticEnabled, embedTexts } from "@/lib/embeddings";
import {
  buildGraph,
  neighborhood,
  type Graph,
  type GraphData,
  type GraphLinkRow,
} from "@/lib/graph";

import { reindexStaleNotes, type Embedder } from "./search";

/**
 * Данные карты связей.
 *
 * Доменный слой отдаёт строки, а не готовый граф: узлы и рёбра собирает
 * src/lib/graph.ts уже на клиенте. Так сделано ради тумблеров слоёв —
 * выключить папки значит пересобрать граф из тех же строк, а не сходить
 * на сервер заново. Сборка чистая и быстрая, ходить за ней некуда.
 *
 * Строки страница грузит на сервере и отдаёт пропсами — так же, как
 * дерево в боковой панели (loadOwnerTree в AppShell).
 */

export async function getGraphData(ownerId: string): Promise<GraphData> {
  return loadGraphData(ownerId);
}

/**
 * Насколько далеко расходится локальная карта на странице заметки.
 *
 * Два шага: соседи и соседи соседей. Один шаг — это уже есть в полосе связей
 * над редактором, и рисовать звезду из того же списка незачем. Три и дальше
 * на маленьком холсте сливаются в кашу, в которой саму заметку не найти.
 */
export const NEIGHBORHOOD_RADIUS = 2;

/**
 * Окрестность заметки — карта на её собственной странице.
 *
 * Слой папок выключен намеренно. Через узел папки двумя шагами притянулись бы
 * все её заметки разом, и вопрос «с чем связана эта» утонул бы в ответе
 * «вот всё, что лежит рядом». Где заметка лежит, и так видно по дереву слева.
 *
 * Смысловой слой, наоборот, нужен — и именно здесь он окупается лучше всего.
 * Ссылок у большинства заметок нет вовсе, и без похожих карта у них честно
 * пуста. А ещё она даёт то, чего не даёт список «Похожие заметки» рядом:
 * список плоский, а два шага показывают, похожи ли найденные между собой —
 * один плотный комок или три отдельные ветки. Просится явно (`similar`),
 * как и у buildGraph: слой стоит перебора векторов и внешнего API.
 *
 * Окрестность вырезается из полного графа владельца, а не выбирается из базы
 * рекурсивным запросом. Это три индексных запроса вместо одного сложного,
 * и на личной базе так дешевле по всем меркам, кроме одной: объём растёт
 * со всей базой, а не с окрестностью. Когда заметок станут тысячи — здесь
 * появится рекурсивный CTE по note_links, и это будет единственное место,
 * которое придётся переписать.
 */
export async function getNoteNeighborhood(
  ownerId: string,
  noteId: string,
  options: { radius?: number; similar?: boolean; embed?: Embedder } = {},
): Promise<Graph> {
  const { radius = NEIGHBORHOOD_RADIUS, similar = false } = options;

  // Последовательно, а не Promise.all: слой похожих сначала догоняет
  // отставшие векторы, а это запись в те же note_chunks, по которым он
  // потом и считается. Выигрыш в пару сотен миллисекунд не стоит гонки.
  const data = await loadGraphData(ownerId);
  const pairs = similar ? (await getSimilarEdges(ownerId, options)).pairs : [];

  const graph = buildGraph(
    { ...data, similar: pairs },
    { folders: false, similar },
  );

  // Чужой или несуществующий noteId даёт пустой граф, а не ошибку:
  // в выборке по владельцу такого узла просто нет.
  return neighborhood(graph, noteId, radius);
}

export interface SimilarEdges {
  pairs: GraphLinkRow[];
  /**
   * Участвовал ли смысловой слой. Отличает «похожих не нашлось» от
   * «искать было нечем» — ровно как SearchResult.semantic.
   */
  semantic: boolean;
}

/**
 * Слой «похожие»: пары близких по смыслу заметок.
 *
 * Отдельным запросом от остального графа, потому что цена другая. Ссылки
 * и папки — это индексный запрос, а здесь полный перебор векторов, да ещё
 * и с возможным вызовом внешнего API на переиндексации. Платить за это
 * при каждом открытии страницы незачем: слой выключен по умолчанию.
 *
 * Отставшие векторы догоняются, как и в блоке «Похожие» под заметкой:
 * иначе только что исправленная заметка соседствовала бы по прошлой
 * редакции текста. Неудача здесь не отменяет слой — покажем по тому,
 * что уже посчитано.
 */
export async function getSimilarEdges(
  ownerId: string,
  options: { embed?: Embedder } = {},
): Promise<SimilarEdges> {
  const embed = options.embed ?? (isSemanticEnabled() ? embedTexts : null);

  // Без векторов похожесть измерить нечем — как и в getRelatedNotes,
  // полнотекстового запасного слоя здесь нет: «похожие по словам»
  // это уже не похожие.
  if (!embed) return { pairs: [], semantic: false };

  try {
    await reindexStaleNotes(ownerId, embed);
  } catch (error) {
    console.error("Не удалось догнать векторы, строим слой по старым:", error);
  }

  return { pairs: await loadSimilarPairs(ownerId), semantic: true };
}
