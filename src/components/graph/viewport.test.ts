import { describe, expect, it } from "vitest";

import {
  fitToNodes,
  hitTest,
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  nodeRadius,
  toGraph,
  toScreen,
  zoomAt,
  type Positioned,
} from "./viewport";

describe("перевод координат", () => {
  const viewport = { x: 100, y: 50, k: 2 };

  it("туда и обратно даёт исходную точку", () => {
    const point = { x: 17, y: -3 };
    const roundTrip = toGraph(viewport, toScreen(viewport, point));

    expect(roundTrip.x).toBeCloseTo(point.x);
    expect(roundTrip.y).toBeCloseTo(point.y);
  });

  it("масштаб и сдвиг применяются в правильном порядке", () => {
    // Сначала масштаб, потом сдвиг: иначе смещение тоже множилось бы на k.
    expect(toScreen(viewport, { x: 10, y: 10 })).toEqual({ x: 120, y: 70 });
  });
});

describe("zoomAt", () => {
  it("точка под курсором остаётся на месте", () => {
    const pivot = { x: 300, y: 200 };
    const before = toGraph(IDENTITY, pivot);
    const after = toGraph(zoomAt(IDENTITY, pivot, 1.7), pivot);

    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("масштаб зажат между пределами", () => {
    const pivot = { x: 0, y: 0 };

    expect(zoomAt(IDENTITY, pivot, 1000).k).toBe(MAX_ZOOM);
    expect(zoomAt(IDENTITY, pivot, 0.0001).k).toBe(MIN_ZOOM);
  });

  it("на упоре карта не съезжает", () => {
    // Иначе прокрутка «дальше некуда» продолжала бы таскать холст.
    const limit = { x: 10, y: 20, k: MAX_ZOOM };

    expect(zoomAt(limit, { x: 300, y: 300 }, 2)).toBe(limit);
  });
});

describe("nodeRadius", () => {
  it("папка крупнее заметки при равной связности", () => {
    expect(nodeRadius({ kind: "folder", degree: 0 })).toBeGreaterThan(
      nodeRadius({ kind: "note", degree: 0 }),
    );
  });

  it("растёт как корень, а не линейно", () => {
    const one = nodeRadius({ kind: "note", degree: 1 });
    const four = nodeRadius({ kind: "note", degree: 4 });
    const nine = nodeRadius({ kind: "note", degree: 9 });

    // Радиусы точных квадратов идут равными шагами — это и есть корень.
    // Линейный рост дал бы 3 и 5.
    expect(four - one).toBeCloseTo(nine - four);
    // И заодно: вдесятеро более связанный узел не в десять раз больше.
    expect(nodeRadius({ kind: "note", degree: 100 })).toBeLessThan(one * 10);
  });
});

describe("fitToNodes", () => {
  const wide: Positioned[] = [
    { id: "l", kind: "note", degree: 0, x: -1000, y: 0 },
    { id: "r", kind: "note", degree: 0, x: 1000, y: 0 },
  ];

  it("широкий граф ужимается так, чтобы влезть", () => {
    const view = fitToNodes(wide, 400, 300);

    expect(view.k).toBeLessThan(1);

    // Оба края попадают на холст с отступом.
    const left = toScreen(view, { x: -1000, y: 0 });
    const right = toScreen(view, { x: 1000, y: 0 });

    expect(left.x).toBeGreaterThanOrEqual(0);
    expect(right.x).toBeLessThanOrEqual(400);
  });

  it("центр графа встаёт в центр холста", () => {
    const view = fitToNodes(wide, 400, 300);
    const center = toScreen(view, { x: 0, y: 0 });

    expect(center.x).toBeCloseTo(200);
    expect(center.y).toBeCloseTo(150);
  });

  it("мелкий граф не раздувается сверх масштаба 1:1", () => {
    // Иначе две точки растянулись бы на весь экран и выглядели бы поломкой.
    const tiny: Positioned[] = [
      { id: "a", kind: "note", degree: 0, x: -5, y: 0 },
      { id: "b", kind: "note", degree: 0, x: 5, y: 0 },
    ];

    expect(fitToNodes(tiny, 1200, 800).k).toBe(1);
  });

  it("узлы без координат не ломают вписывание", () => {
    // Так выглядит холст до первого тика симуляции.
    expect(fitToNodes([{ id: "a", kind: "note", degree: 0 }], 400, 300)).toEqual({
      x: 200,
      y: 150,
      k: 1,
    });
  });

  it("масштаб не проваливается ниже предела", () => {
    const huge: Positioned[] = [
      { id: "a", kind: "note", degree: 0, x: -1e6, y: 0 },
      { id: "b", kind: "note", degree: 0, x: 1e6, y: 0 },
    ];

    expect(fitToNodes(huge, 400, 300).k).toBe(MIN_ZOOM);
  });
});

describe("hitTest", () => {
  const nodes: Positioned[] = [
    { id: "a", kind: "note", degree: 0, x: 0, y: 0 },
    { id: "b", kind: "note", degree: 0, x: 40, y: 0 },
  ];

  it("попадание в узел возвращает его", () => {
    expect(hitTest(nodes, { x: 2, y: 2 }, IDENTITY)?.id).toBe("a");
  });

  it("мимо всех — null", () => {
    expect(hitTest(nodes, { x: 20, y: 20 }, IDENTITY)).toBeNull();
  });

  it("в скоплении берётся ближайший, а не первый в списке", () => {
    const crowd: Positioned[] = [
      { id: "далёкий", kind: "folder", degree: 30, x: 0, y: 0 },
      { id: "близкий", kind: "note", degree: 0, x: 12, y: 0 },
    ];

    expect(hitTest(crowd, { x: 11, y: 0 }, IDENTITY)?.id).toBe("близкий");
  });

  it("узел без координат пропускается", () => {
    // До первого тика симуляции координат нет вообще.
    expect(hitTest([{ id: "n", kind: "note", degree: 0 }], { x: 0, y: 0 }, IDENTITY)).toBeNull();
  });

  it("на отдалении допуск растёт, иначе в узел не попасть", () => {
    const far = { x: 0, y: 0, k: 0.2 };
    const point = { x: 0, y: 14 };

    // Радиус узла 4, допуск 4 экранных пикселя: при k = 1 это 8 и промах,
    // при k = 0,2 — 4 + 20 и попадание.
    expect(hitTest(nodes, point, IDENTITY)).toBeNull();
    expect(hitTest(nodes, point, far)?.id).toBe("a");
  });
});
