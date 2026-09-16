import type { GraphNode } from "@/lib/graph";

/**
 * Геометрия холста: масштаб, перевод координат и попадание курсором.
 *
 * Отдельно от компонента, потому что это единственная часть графа, которую
 * можно проверить, не рисуя: ошибка в пересчёте координат выглядит как
 * «клик промахивается мимо узла», и ловить её глазами дороже, чем тестом.
 */

/** Сдвиг и масштаб холста. Экран = граф × k + смещение. */
export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Границы масштаба: дальше карта нечитаема с обеих сторон. */
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4;

export const IDENTITY: Viewport = { x: 0, y: 0, k: 1 };

/** Точка графа → точка на экране. */
export function toScreen(viewport: Viewport, point: Point): Point {
  return {
    x: point.x * viewport.k + viewport.x,
    y: point.y * viewport.k + viewport.y,
  };
}

/** Точка на экране → точка графа. */
export function toGraph(viewport: Viewport, point: Point): Point {
  return {
    x: (point.x - viewport.x) / viewport.k,
    y: (point.y - viewport.y) / viewport.k,
  };
}

/**
 * Масштабирование вокруг точки экрана: то, что было под курсором, под ним
 * и остаётся. Без этого колесо тянет карту в сторону от места, куда смотришь.
 */
export function zoomAt(
  viewport: Viewport,
  pivot: Point,
  factor: number,
): Viewport {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.k * factor));

  // Упёрлись в предел — двигать нечего, иначе карта поедет при
  // прокрутке «в никуда».
  if (k === viewport.k) return viewport;

  const anchor = toGraph(viewport, pivot);

  return {
    k,
    x: pivot.x - anchor.x * k,
    y: pivot.y - anchor.y * k,
  };
}

/**
 * Радиус узла в координатах графа.
 *
 * Корень из степени, а не сама степень: площадь круга растёт как квадрат
 * радиуса, и линейный радиус раздувал бы связанный узел до неприличия.
 * Это та же величина, что задавала кегль в облаке тегов, — насколько узел
 * связан с остальными.
 */
export function nodeRadius(node: Pick<GraphNode, "kind" | "degree">): number {
  const base = node.kind === "folder" ? 7 : 4;
  return base + Math.sqrt(node.degree) * 2.2;
}

/** Отступ от края холста при вписывании, в пикселях экрана. */
const FIT_PADDING = 32;

/**
 * Вид, при котором весь граф помещается на холсте.
 *
 * Нужен и при первом показе, и по кнопке «по размеру». Без него карта
 * открывалась бы в масштабе 1:1 из центра: на широком графе края уезжают
 * за пределы холста, а на узком телефоне не видно почти ничего.
 *
 * Приближать сверх единицы не даёт: граф из двух узлов, растянутый
 * на весь экран, выглядит сломанным, а не подробным.
 */
export function fitToNodes(
  nodes: readonly Positioned[],
  width: number,
  height: number,
  padding = FIT_PADDING,
): Viewport {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const node of nodes) {
    if (node.x === undefined || node.y === undefined) continue;

    const radius = nodeRadius(node);
    minX = Math.min(minX, node.x - radius);
    minY = Math.min(minY, node.y - radius);
    maxX = Math.max(maxX, node.x + radius);
    maxY = Math.max(maxY, node.y + radius);
  }

  // До первого тика координат нет ни у кого — центрируем пустоту.
  if (minX === Infinity) return { x: width / 2, y: height / 2, k: 1 };

  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  const k = Math.min(
    1,
    Math.max(
      MIN_ZOOM,
      Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY),
    ),
  );

  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/** Узел под курсором. Координаты — в системе графа. */
export interface Positioned {
  id: string;
  x?: number;
  y?: number;
  kind: GraphNode["kind"];
  degree: number;
}

/**
 * Ближайший узел под точкой или null.
 *
 * Перебором: на полутора тысячах узлов (GRAPH_NODE_LIMIT) это десятки
 * микросекунд, а квадродерево пришлось бы перестраивать на каждом тике
 * симуляции — то есть шестьдесят раз в секунду.
 *
 * tolerance задаётся в пикселях экрана и делится на масштаб: на отдалённой
 * карте узлы мелкие, и попасть в них мышью иначе невозможно.
 */
export function hitTest<T extends Positioned>(
  nodes: readonly T[],
  point: Point,
  viewport: Viewport,
  tolerance = 4,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;

  for (const node of nodes) {
    if (node.x === undefined || node.y === undefined) continue;

    const dx = node.x - point.x;
    const dy = node.y - point.y;
    const distance = Math.hypot(dx, dy);
    const reach = nodeRadius(node) + tolerance / viewport.k;

    if (distance > reach) continue;

    // Меньше по расстоянию, а не по индексу: в скоплении курсор должен
    // брать тот узел, к центру которого он ближе.
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }

  return best;
}
