"use client";

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { MaximizeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { createRandom, type GraphEdge, type GraphNode } from "@/lib/graph";

import {
  fitToNodes,
  hitTest,
  nodeRadius,
  toGraph,
  zoomAt,
  type Point,
  type Viewport,
} from "./viewport";

/**
 * Холст графа связей.
 *
 * Canvas, а не SVG: узлов до полутора тысяч (GRAPH_NODE_LIMIT), и каждый тик
 * симуляции двигает их все. На SVG это столько же изменений в DOM шестьдесят
 * раз в секунду — браузер начинает захлёбываться уже на паре сотен. На холсте
 * то же самое стоит одного вызова отрисовки, платой за это идут ручное
 * попадание курсором (viewport.ts) и невидимость для скринридера — её
 * закрывает список рядом (graph-list.tsx).
 *
 * React здесь только монтирует холст. Ни наведение, ни перетаскивание, ни
 * масштаб не живут в состоянии: каждое из них меняется десятки раз в секунду
 * и вызывало бы столько же перерисовок дерева компонентов ни за чем. Всё
 * изменяемое лежит в ref, а единственный потребитель — функция draw.
 */

/** Узел в симуляции: к нашим полям d3 дописывает координаты и скорости. */
type SimNode = GraphNode & SimulationNodeDatum;

/** Ребро: d3 заменяет строковые идентификаторы ссылками на узлы. */
type SimEdge = Omit<GraphEdge, "source" | "target"> &
  SimulationLinkDatum<SimNode>;

/**
 * Зерно раскладки. Строка, а не отсутствие зерна: d3-force по умолчанию
 * берёт Math.random, и одна и та же карта выходила бы каждый раз другой.
 */
const LAYOUT_SEED = "md-note";

/** Ниже этого масштаба подписи сливаются в кашу и не рисуются. */
const LABEL_ZOOM = 0.8;

/** Узел с такой связностью подписан всегда — это опора карты. */
const ALWAYS_LABELED_DEGREE = 4;

/** Дальше этого сдвига нажатие считается перетаскиванием, а не кликом. */
const CLICK_SLOP = 4;

/** Сколько тиков раскладки считается до первой отрисовки. */
const PRETICKS = 120;

/** Во сколько раз меняет масштаб одно нажатие кнопки «+» или «−». */
const ZOOM_STEP = 1.4;

/**
 * Потолок на число подписей в кадре. Нужен не ради чтения — столько всё
 * равно не прочесть, — а ради расстановки: каждая подпись сверяется
 * с уже поставленными, и без потолка это было бы квадратично от числа
 * узлов на каждом кадре.
 */
const MAX_LABELS = 140;

/**
 * Длина подписи на холсте. Заголовок бывает до 200 символов
 * (LIMITS.titleMaxLength), и такой на карте перекрыл бы полэкрана.
 */
const LABEL_CHARS = 22;

function shorten(title: string): string {
  return title.length > LABEL_CHARS
    ? `${title.slice(0, LABEL_CHARS - 1)}…`
    : title;
}

interface Palette {
  note: string;
  folder: string;
  highlight: string;
  edge: string;
  label: string;
}

export function GraphCanvas({
  nodes,
  edges,
  matched,
  rootId,
  className,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Заметка, вокруг которой построена карта. Обводится кольцом — на
   * локальном графе без этого непонятно, которая из точек «ты».
   */
  rootId?: string;
  /**
   * Что подошло под фильтр. null — фильтра нет, гасить нечего; пустое
   * множество — фильтр есть и не подошло ничего, и карта гаснет целиком.
   */
  matched?: ReadonlySet<string> | null;
  className?: string;
}) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Узлы и рёбра, с которыми работает симуляция.
   *
   * Копии пропсов: d3 дописывает в узлы координаты и скорости, а в рёбрах
   * подменяет строковые идентификаторы ссылками на узлы. Мутировать пропсы
   * нельзя, и держать копии в useMemo тоже нельзя — значение, вычисленное
   * при рендере, после него неприкосновенно. Ref для того и существует.
   *
   * Заполняется в эффекте симуляции, читается отрисовкой и обработчиками.
   */
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[] }>({
    nodes: [],
    edges: [],
  });

  /** Кто с кем связан — для подсветки соседей. Строится один раз. */
  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>();

    const add = (from: string, to: string) => {
      const set = map.get(from);
      if (set) set.add(to);
      else map.set(from, new Set([to]));
    };

    for (const edge of edges) {
      add(edge.source, edge.target);
      add(edge.target, edge.source);
    }

    return map;
  }, [edges]);

  const viewportRef = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const hoveredRef = useRef<string | null>(null);

  /**
   * Фильтр держится в ref, а не в зависимостях draw. Иначе каждое нажатие
   * клавиши меняло бы draw, а вместе с ним и эффект симуляции — карта
   * раскладывалась бы заново на каждую букву.
   */
  const matchedRef = useRef<ReadonlySet<string> | null | undefined>(matched);
  const draggingRef = useRef<SimNode | null>(null);
  const paletteRef = useRef<Palette | null>(null);
  const frameRef = useRef<number | null>(null);

  /** Вписывали ли граф в холст хоть раз. См. resize ниже. */
  const fittedRef = useRef(false);

  /**
   * Подогрев симуляции снаружи эффекта. Функция, а не ссылка на симуляцию:
   * циклом отрисовки владеет эффект, и он единственный имеет право его
   * заводить — иначе перетаскивание оставляло бы после себя второй цикл,
   * который продолжал бы крутиться и после размонтирования.
   */
  const kickRef = useRef<((alpha: number) => void) | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const palette = paletteRef.current;
    if (!canvas || !palette) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = canvas.width / ratio;
    const height = canvas.height / ratio;
    const viewport = viewportRef.current;
    const hovered = hoveredRef.current;
    const lit = hovered ? neighbors.get(hovered) : undefined;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(viewport.x, viewport.y);
    context.scale(viewport.k, viewport.k);

    const filter = matchedRef.current;

    /**
     * Узел показывается в полную силу: он причастен к наведению (сам или
     * сосед) и проходит фильтр. Два условия перемножаются, а не спорят:
     * наведясь на узел при включённом фильтре, человек ждёт увидеть его
     * соседей, но не ждёт, что фильтр перестанет действовать.
     */
    const isLit = (id: string) =>
      (!hovered || id === hovered || !!lit?.has(id)) &&
      (!filter || filter.has(id));

    // Рёбра под узлами, иначе линии перечёркивают кружки.
    for (const edge of simRef.current.edges) {
      const from = edge.source as SimNode;
      const to = edge.target as SimNode;
      if (from.x === undefined || to.x === undefined) continue;

      const active = isLit(from.id) && isLit(to.id);

      context.beginPath();
      context.moveTo(from.x, from.y!);
      context.lineTo(to.x, to.y!);
      context.strokeStyle = active && hovered ? palette.highlight : palette.edge;

      // Делится на масштаб, потому что контекст уже отмасштабирован: на
      // экране толщина выходит постоянной, сколько ни приближай. Ссылка
      // толще остальных — она единственная связь, проведённая руками.
      // Пунктир и точки тоньше, но не настолько, чтобы теряться: на
      // 0,7 пикселя браузер размазывал их в полутень.
      context.lineWidth = (edge.kind === "link" ? 1.4 : 1) / viewport.k;

      // Три разных вида линии под три разных утверждения. Сплошная —
      // ссылка, её поставил человек. Пунктир — папка, это структура дерева.
      // Точки — догадка косинуса. Выдавать догадку за проведённую связь
      // нельзя, и разный вид линии — единственное, чем они здесь
      // различаются (то же правило, что в src/domain/connections.ts).
      context.setLineDash(
        edge.kind === "folder"
          ? [3 / viewport.k, 3 / viewport.k]
          : edge.kind === "similar"
            ? [1 / viewport.k, 3 / viewport.k]
            : [],
      );
      context.globalAlpha = active ? 0.9 : 0.12;
      context.stroke();
    }

    context.setLineDash([]);
    context.globalAlpha = 1;

    for (const node of simRef.current.nodes) {
      if (node.x === undefined || node.y === undefined) continue;

      const radius = nodeRadius(node);
      const active = isLit(node.id);

      context.globalAlpha = active ? 1 : 0.15;
      context.fillStyle =
        node.id === hovered
          ? palette.highlight
          : node.kind === "folder"
            ? palette.folder
            : palette.note;

      context.beginPath();

      if (node.kind === "folder") {
        // Папка — скруглённый квадрат: вид узла не должен читаться
        // только цветом.
        context.roundRect(
          node.x - radius,
          node.y - radius,
          radius * 2,
          radius * 2,
          radius / 2,
        );
      } else {
        context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      }

      context.fill();

      // Кольцо вокруг заметки, которой принадлежит карта. Не заливкой:
      // заливка занята наведением, и «ты здесь» не должно выглядеть как
      // «сюда навели».
      if (node.id === rootId) {
        context.strokeStyle = palette.highlight;
        context.lineWidth = 2 / viewport.k;
        context.beginPath();
        context.arc(node.x, node.y, radius + 3 / viewport.k, 0, Math.PI * 2);
        context.stroke();
      }
    }

    // Подписи последними: они должны лежать поверх всего.
    const labelSize = 12 / viewport.k;
    context.font = `${labelSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "top";

    /**
     * Важность узла для подписи. Сначала то, на что смотрят прямо сейчас,
     * потом папки, потом связанность. Порядок решает, чья подпись уцелеет
     * в споре за место.
     */
    const weight = (node: SimNode) =>
      (node.id === hovered ? 1e6 : 0) +
      (lit?.has(node.id) ? 1e5 : 0) +
      (node.kind === "folder" ? 1e4 : 0) +
      node.degree;

    const candidates = simRef.current.nodes
      .filter((node) => {
        if (node.x === undefined || node.y === undefined) return false;

        // На отдалении подписываем только опорные узлы: иначе экран
        // превращается в сплошной текст, сквозь который не видно связей.
        return (
          viewport.k >= LABEL_ZOOM ||
          node.id === hovered ||
          !!lit?.has(node.id) ||
          node.kind === "folder" ||
          node.degree >= ALWAYS_LABELED_DEGREE
        );
      })
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, MAX_LABELS);

    // Занятые прямоугольники — в координатах графа: масштаб и сдвиг
    // одинаковы для всех, и на пересечения это не влияет.
    const taken: Array<[number, number, number, number]> = [];
    const lineHeight = labelSize * 1.1;

    for (const node of candidates) {
      const text = shorten(node.title);
      const halfWidth = context.measureText(text).width / 2;
      const top = node.y! + nodeRadius(node) + 3 / viewport.k;

      const box: [number, number, number, number] = [
        node.x! - halfWidth,
        top,
        node.x! + halfWidth,
        top + lineHeight,
      ];

      // Подпись, которой некуда встать, не рисуется вовсе. Наложенные
      // друг на друга заголовки нечитаемы оба — лучше показать один.
      const collides = taken.some(
        ([left, upper, right, lower]) =>
          box[0] < right && box[2] > left && box[1] < lower && box[3] > upper,
      );

      if (collides) continue;

      taken.push(box);

      context.globalAlpha = isLit(node.id) ? 1 : 0.15;
      context.fillStyle = palette.label;
      context.fillText(text, node.x!, top);
    }

    context.globalAlpha = 1;
  }, [neighbors, rootId]);

  /** Просит перерисовку к следующему кадру, а не рисует прямо сейчас. */
  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  // Фильтр меняется на каждое нажатие клавиши, и перекладывать из-за него
  // карту нельзя. Кладём в ref и просим только перерисовку.
  useEffect(() => {
    matchedRef.current = matched;
    requestDraw();
  }, [matched, requestDraw]);

  // Симуляция. Пересоздаётся только при смене состава графа.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Свежие копии на каждый состав графа: прошлые несут в себе координаты
    // и подменённые концы рёбер от предыдущей симуляции.
    const simNodes: SimNode[] = nodes.map((node) => ({ ...node }));
    const simEdges: SimEdge[] = edges.map((edge) => ({ ...edge }));

    simRef.current = { nodes: simNodes, edges: simEdges };

    // Стартовые координаты задаём сами, а не полагаемся на те, что
    // расставит d3. Своих у него детерминированные, но он расставляет их
    // только узлам без координат — а координаты у наших узлов уже могут
    // быть: в dev React монтирует эффект дважды, и второй запуск получил бы
    // то, что успел намотать первый. Сколько он успел, зависит от таймингов,
    // и одна и та же база раскладывалась бы каждый раз по-новому.
    const start = createRandom(LAYOUT_SEED);
    const spread = 40 * Math.sqrt(simNodes.length);

    for (const node of simNodes) {
      const angle = start() * Math.PI * 2;
      // Корень от равномерного числа — иначе узлы сгущаются к центру:
      // площадь кольца растёт с радиусом.
      const distance = Math.sqrt(start()) * spread;

      node.x = Math.cos(angle) * distance;
      node.y = Math.sin(angle) * distance;
      node.vx = 0;
      node.vy = 0;

      // Заметка, вокруг которой построена карта, прибита к центру холста.
      // На маленьком графе это важнее свободной раскладки: искать глазами
      // «где тут я» на карте из пяти узлов — нелепое занятие.
      if (node.id === rootId) {
        node.x = 0;
        node.y = 0;
        node.fx = 0;
        node.fy = 0;
      }
    }

    const simulation = forceSimulation(simNodes)
      // Детерминированный источник вместо Math.random: тем же целям служит,
      // что и стартовые координаты выше, — карта обязана быть узнаваемой
      // от открытия к открытию.
      .randomSource(createRandom(LAYOUT_SEED))
      .force(
        "link",
        forceLink<SimNode, SimEdge>(simEdges)
          .id((node) => node.id)
          // Ссылка тянет сильнее принадлежности папке: рукотворная связь
          // должна побеждать структуру дерева, а не тонуть в ней. Длина
          // при этом больше у ссылки — иначе связанная пара слипается
          // в одно пятно и самой линии между ними не видно.
          .distance((edge) => (edge.kind === "folder" ? 60 : 90))
          .strength((edge) => (edge.kind === "folder" ? 0.25 : 0.7)),
      )
      .force("charge", forceManyBody<SimNode>().strength(-260).distanceMax(500))
      .force("center", forceCenter(0, 0))
      .force(
        "collide",
        forceCollide<SimNode>().radius((node) => nodeRadius(node) + 3),
      )
      .stop();

    // Часть тиков досчитываем разом, не рисуя. Полная раскладка — это
    // около трёхсот тиков, то есть пять секунд по кадру за тик: всё это
    // время карта расползалась бы из точки на глазах. После пачки тиков
    // она открывается почти собранной, а остаток доводит анимация.
    // Дорого это не выходит: forceManyBody обходит квадродерево, и сотня
    // тиков даже на пределе в полторы тысячи узлов считается за доли секунды.
    simulation.tick(PRETICKS);

    // Тикаем сами, а не подписываемся на d3-таймер: рисовать надо ровно
    // столько же раз, сколько считать, и останавливаться, когда карта
    // застыла. Иначе цикл крутится вхолостую, пока открыта вкладка.
    let frame: number | null = null;
    let disposed = false;

    const ensureRunning = () => {
      if (disposed || frame !== null) return;
      frame = requestAnimationFrame(run);
    };

    function run() {
      // Обнуляем до работы, а не после: ensureRunning из обработчика,
      // сработавшего между тиком и следующим кадром, иначе решил бы,
      // что цикл уже идёт, и остался бы ни с чем.
      frame = null;

      simulation.tick();
      draw();

      if (simulation.alpha() > simulation.alphaMin()) ensureRunning();
    }

    kickRef.current = (alpha: number) => {
      if (disposed) return;
      simulation.alpha(alpha);
      ensureRunning();
    };

    ensureRunning();

    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      kickRef.current = null;
      simulation.stop();
    };
  }, [draw, edges, nodes, rootId]);

  /** Подогревает остывшую симуляцию — после перетаскивания узла. */
  const reheat = useCallback(() => kickRef.current?.(0.3), []);

  /** Вписывает весь граф в холст. Он же — кнопка «по размеру». */
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    viewportRef.current = fitToNodes(
      simRef.current.nodes,
      rect.width,
      rect.height,
    );

    requestDraw();
  }, [requestDraw]);

  /** Масштаб кнопками — от центра холста, как будто колесом посередине. */
  const zoomBy = useCallback(
    (factor: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      viewportRef.current = zoomAt(
        viewportRef.current,
        { x: rect.width / 2, y: rect.height / 2 },
        factor,
      );

      requestDraw();
    },
    [requestDraw],
  );

  // Размер холста, палитра и первичная установка вида.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const readPalette = () => {
      const styles = getComputedStyle(canvas);
      paletteRef.current = {
        note: styles.getPropertyValue("--graph-note").trim(),
        folder: styles.getPropertyValue("--graph-folder").trim(),
        highlight: styles.getPropertyValue("--graph-highlight").trim(),
        edge: styles.getPropertyValue("--graph-edge").trim(),
        label: styles.getPropertyValue("--graph-label").trim(),
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;

      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));

      // Вписываем только при первом измерении. Дальше вид принадлежит
      // человеку: изменение размера окна или сворачивание боковой панели
      // не должны отменять то, что он приблизил и подвинул.
      if (!fittedRef.current) {
        fittedRef.current = true;
        fit();
        return;
      }

      requestDraw();
    };

    readPalette();
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // Тема меняется в системе, а не в приложении: переключателя нет,
    // токены живут в prefers-color-scheme. Холст про это не узнает сам.
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      readPalette();
      requestDraw();
    };

    scheme.addEventListener("change", onScheme);

    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", onScheme);
    };
  }, [fit, requestDraw]);

  /** Точка события в координатах графа. */
  const pointOf = useCallback((event: React.PointerEvent): Point => {
    const rect = event.currentTarget.getBoundingClientRect();

    return toGraph(viewportRef.current, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }, []);

  // Панорама и перетаскивание: откуда началось нажатие и сдвинулось ли оно
  // настолько, чтобы перестать быть кликом.
  const gestureRef = useRef<{
    pointerId: number;
    screen: Point;
    moved: boolean;
  } | null>(null);

  /**
   * Пальцы на экране. Колеса на телефоне нет, и без щипка масштаб там
   * менялся бы только кнопками — по карте это ощущается как поломка.
   */
  const touchesRef = useRef(new Map<number, Point>());

  /** Расстояние между двумя пальцами и точка посередине. */
  const pinchRef = useRef<{ distance: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);

    touchesRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    // Второй палец превращает жест в щипок: начатое перетаскивание узла
    // отменяется, иначе он поехал бы вместе с масштабом.
    if (touchesRef.current.size === 2) {
      draggingRef.current = null;
      gestureRef.current = null;
      pinchRef.current = null;
      return;
    }

    const node = hitTest(simRef.current.nodes, pointOf(event), viewportRef.current);

    if (node) {
      draggingRef.current = node;
      reheat();
    }

    gestureRef.current = {
      pointerId: event.pointerId,
      screen: { x: event.clientX, y: event.clientY },
      moved: false,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const touches = touchesRef.current;

    if (touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (touches.size === 2) {
      const [first, second] = [...touches.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const previous = pinchRef.current?.distance;

      pinchRef.current = { distance };

      // Первый кадр щипка задаёт точку отсчёта, менять масштаб ещё не от чего.
      if (previous && previous > 0) {
        const rect = event.currentTarget.getBoundingClientRect();

        viewportRef.current = zoomAt(
          viewportRef.current,
          {
            x: (first.x + second.x) / 2 - rect.left,
            y: (first.y + second.y) / 2 - rect.top,
          },
          distance / previous,
        );

        requestDraw();
      }

      return;
    }

    const gesture = gestureRef.current;
    const point = pointOf(event);

    if (gesture) {
      const shift = Math.hypot(
        event.clientX - gesture.screen.x,
        event.clientY - gesture.screen.y,
      );

      if (shift > CLICK_SLOP) gesture.moved = true;

      const dragged = draggingRef.current;

      if (dragged) {
        // fx/fy пришпиливают узел: пока его держат, силы на него не влияют.
        dragged.fx = point.x;
        dragged.fy = point.y;
        reheat();
        return;
      }

      if (gesture.moved) {
        viewportRef.current = {
          ...viewportRef.current,
          x: viewportRef.current.x + event.movementX,
          y: viewportRef.current.y + event.movementY,
        };
        requestDraw();
        return;
      }
    }

    const hovered = hitTest(simRef.current.nodes, point, viewportRef.current);
    const id = hovered?.id ?? null;

    if (id !== hoveredRef.current) {
      hoveredRef.current = id;
      event.currentTarget.style.cursor = id ? "pointer" : "grab";
      requestDraw();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    touchesRef.current.delete(event.pointerId);
    if (touchesRef.current.size < 2) pinchRef.current = null;

    const gesture = gestureRef.current;
    const dragged = draggingRef.current;

    gestureRef.current = null;
    draggingRef.current = null;

    if (dragged && dragged.id !== rootId) {
      // Отпускаем пришпиленность: узел остаётся там, куда его принесли,
      // но снова участвует в раскладке. Оставить fx/fy значило бы
      // получить карту, застывающую по кусочкам. Корень — исключение:
      // он закреплён с самого начала и остаётся закреплённым там,
      // куда его перетащили.
      dragged.fx = null;
      dragged.fy = null;
    }

    if (!gesture || gesture.moved) return;

    const node = hitTest(simRef.current.nodes, pointOf(event), viewportRef.current);

    // Кликом открывается только заметка. Папка узел на карте, но не
    // страница: её содержимое показывает дерево слева.
    if (node && node.kind === "note") router.push(`/n/${node.id}`);
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();

    viewportRef.current = zoomAt(
      viewportRef.current,
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      Math.pow(0.999, event.deltaY),
    );

    requestDraw();
  };

  return (
    <div className={`relative ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        // Холст для скринридера — пустой прямоугольник. Роль и подпись есть,
        // но содержимое читается из списка рядом (graph-list.tsx).
        role="img"
        aria-label="Карта связей между заметками"
        className="size-full"
        // touch-action: none — иначе браузер забирает себе жесты на холсте
        // и ни панорамы, ни щипка обработчики не увидят.
        style={{ cursor: "grab", touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />

      {/* Кнопки, а не только колесо: на телефоне колеса нет, а щипок
          двумя пальцами получается не у всех и не всегда. «По размеру»
          нужен и на десктопе — вернуть карту на место после блужданий. */}
      <div className="absolute right-2 bottom-2 flex gap-1">
        <ZoomButton label="Отдалить" onClick={() => zoomBy(1 / ZOOM_STEP)}>
          −
        </ZoomButton>
        <ZoomButton label="Приблизить" onClick={() => zoomBy(ZOOM_STEP)}>
          +
        </ZoomButton>
        <ZoomButton label="Вписать карту целиком" onClick={fit}>
          <MaximizeIcon className="size-3.5" />
        </ZoomButton>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-md border bg-background/80 text-sm text-muted-foreground backdrop-blur hover:text-foreground"
    >
      {children}
    </button>
  );
}
