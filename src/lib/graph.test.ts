import { describe, expect, it } from "vitest";

import {
  buildGraph,
  createRandom,
  limitNodes,
  neighborhood,
  splitIsolated,
  type Graph,
  type GraphData,
} from "./graph";

/**
 * Сборка графа — чистая функция, поэтому проверяется без базы.
 * Что связи действительно доезжают до неё из Postgres, проверяет
 * tests/graph.test.ts.
 */

const NOW = new Date("2026-09-16T00:00:00Z");

function data(partial: Partial<GraphData> = {}): GraphData {
  return { notes: [], folders: [], links: [], ...partial };
}

function note(id: string, folderId: string | null = null) {
  return { id, title: `Заметка ${id}`, folderId, updatedAt: NOW };
}

function folder(id: string, parentId: string | null = null) {
  return { id, title: `Папка ${id}`, parentId };
}

/** Рёбра как «a→b», чтобы сравнивать списки не глядя на порядок полей. */
function pairs(graph: Graph, kind?: "link" | "folder" | "similar"): string[] {
  return graph.edges
    .filter((edge) => !kind || edge.kind === kind)
    .map((edge) => `${edge.source}→${edge.target}`)
    .sort();
}

function degreeOf(graph: Graph, id: string): number {
  return graph.nodes.find((node) => node.id === id)!.degree;
}

describe("buildGraph", () => {
  it("ссылка в базе становится ребром между заметками", () => {
    const graph = buildGraph(
      data({
        notes: [note("a"), note("b")],
        links: [{ sourceId: "a", targetId: "b" }],
      }),
    );

    expect(pairs(graph, "link")).toEqual(["a→b"]);
    expect(degreeOf(graph, "a")).toBe(1);
    expect(degreeOf(graph, "b")).toBe(1);
  });

  it("ссылка на отсутствующую заметку выбрасывается", () => {
    // Так выглядит ссылка на архивную или чужую заметку: строка в note_links
    // есть, а узла нет. Ребро в никуда уронило бы раскладку.
    const graph = buildGraph(
      data({ notes: [note("a")], links: [{ sourceId: "a", targetId: "нет" }] }),
    );

    expect(graph.edges).toHaveLength(0);
    expect(degreeOf(graph, "a")).toBe(0);
  });

  it("взаимная пара остаётся двумя рёбрами", () => {
    const graph = buildGraph(
      data({
        notes: [note("a"), note("b")],
        links: [
          { sourceId: "a", targetId: "b" },
          { sourceId: "b", targetId: "a" },
        ],
      }),
    );

    expect(pairs(graph, "link")).toEqual(["a→b", "b→a"]);
    expect(degreeOf(graph, "a")).toBe(2);
  });

  it("папки дают узлы и скелет дерева", () => {
    const graph = buildGraph(
      data({
        notes: [note("n", "child")],
        folders: [folder("root"), folder("child", "root")],
      }),
    );

    expect(graph.nodes.map((node) => node.id).sort()).toEqual([
      "child",
      "n",
      "root",
    ]);
    expect(pairs(graph, "folder")).toEqual(["child→root", "n→child"]);
  });

  it("узел красится по папке: заметка — своей, папка — родительской", () => {
    const graph = buildGraph(
      data({
        notes: [note("n", "child")],
        folders: [folder("root"), folder("child", "root")],
      }),
    );

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));

    expect(byId.get("n")!.folderId).toBe("child");
    expect(byId.get("child")!.folderId).toBe("root");
    expect(byId.get("root")!.folderId).toBeNull();
  });

  it("без слоя папок остаются только заметки и ссылки", () => {
    const graph = buildGraph(
      data({
        notes: [note("a", "f"), note("b", "f")],
        folders: [folder("f")],
        links: [{ sourceId: "a", targetId: "b" }],
      }),
      { folders: false },
    );

    expect(graph.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(pairs(graph)).toEqual(["a→b"]);
  });

  it("слой похожих даёт рёбра только по включённому тумблеру", () => {
    const rows = data({
      notes: [note("a"), note("b")],
      similar: [{ sourceId: "a", targetId: "b" }],
    });

    expect(buildGraph(rows).edges).toHaveLength(0);
    expect(pairs(buildGraph(rows, { similar: true }), "similar")).toEqual([
      "a→b",
    ]);
  });

  it("похожесть считается за одну связь, а не за две", () => {
    // Пары приходят из базы свёрнутыми. Если бы слой добавлял ещё и
    // обратное ребро, степень узлов удвоилась бы на ровном месте.
    const graph = buildGraph(
      data({
        notes: [note("a"), note("b")],
        similar: [{ sourceId: "a", targetId: "b" }],
      }),
      { similar: true },
    );

    expect(degreeOf(graph, "a")).toBe(1);
    expect(degreeOf(graph, "b")).toBe(1);
  });

  it("похожесть на отсутствующую заметку выбрасывается", () => {
    const graph = buildGraph(
      data({ notes: [note("a")], similar: [{ sourceId: "a", targetId: "нет" }] }),
      { similar: true },
    );

    expect(graph.edges).toHaveLength(0);
  });

  it("ссылка и похожесть между теми же заметками — два разных ребра", () => {
    // Так и задумано: человек связал их сам, и косинус тоже считает их
    // близкими. Это два утверждения, и на карте они рисуются по-разному.
    const graph = buildGraph(
      data({
        notes: [note("a"), note("b")],
        links: [{ sourceId: "a", targetId: "b" }],
        similar: [{ sourceId: "a", targetId: "b" }],
      }),
      { similar: true },
    );

    expect(graph.edges.map((edge) => edge.kind).sort()).toEqual([
      "link",
      "similar",
    ]);
  });

  it("заметка в корне не получает ребра к папке", () => {
    const graph = buildGraph(
      data({ notes: [note("a")], folders: [folder("f")] }),
    );

    expect(graph.edges).toHaveLength(0);
  });
});

describe("splitIsolated", () => {
  it("узлы без рёбер уходят в отдельный список", () => {
    const graph = buildGraph(
      data({
        notes: [note("a"), note("b"), note("одиночка")],
        links: [{ sourceId: "a", targetId: "b" }],
      }),
    );

    const split = splitIsolated(graph);

    expect(split.graph.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(split.isolated.map((node) => node.id)).toEqual(["одиночка"]);
  });

  it("слой папок вытаскивает заметку из одиночек", () => {
    // Ради этого слой и нужен: заметка, ни на что не ссылающаяся,
    // всё равно видна на карте — рядом со своей папкой.
    const rows = data({ notes: [note("a", "f")], folders: [folder("f")] });

    expect(splitIsolated(buildGraph(rows, { folders: false })).isolated).toHaveLength(1);
    expect(splitIsolated(buildGraph(rows, { folders: true })).isolated).toHaveLength(0);
  });
});

describe("limitNodes", () => {
  const graph = buildGraph(
    data({
      notes: [note("центр"), note("a"), note("b"), note("край")],
      links: [
        { sourceId: "a", targetId: "центр" },
        { sourceId: "b", targetId: "центр" },
        { sourceId: "край", targetId: "a" },
      ],
    }),
  );

  it("под пределом граф не трогается", () => {
    const limited = limitNodes(graph, 10);

    expect(limited.graph).toBe(graph);
    expect(limited.omitted).toBe(0);
  });

  it("остаются самые связанные узлы", () => {
    const limited = limitNodes(graph, 2);

    expect(limited.graph.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "центр",
    ]);
    expect(limited.omitted).toBe(2);
  });

  it("степени пересчитываются по оставшимся рёбрам", () => {
    // У «центра» в полном графе две связи, в вырезе — одна.
    expect(degreeOf(graph, "центр")).toBe(2);
    expect(degreeOf(limitNodes(graph, 2).graph, "центр")).toBe(1);
  });

  it("рёбра с отрезанным концом выбрасываются", () => {
    expect(pairs(limitNodes(graph, 2).graph)).toEqual(["a→центр"]);
  });
});

describe("neighborhood", () => {
  const graph = buildGraph(
    data({
      notes: [note("корень"), note("сосед"), note("дальний"), note("чужой")],
      links: [
        { sourceId: "сосед", targetId: "корень" },
        { sourceId: "сосед", targetId: "дальний" },
      ],
    }),
  );

  it("радиус 1 берёт только прямых соседей", () => {
    expect(
      neighborhood(graph, "корень", 1)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(["корень", "сосед"]);
  });

  it("радиус 2 достаёт соседей соседей", () => {
    expect(
      neighborhood(graph, "корень", 2)
        .nodes.map((node) => node.id)
        .sort(),
    ).toEqual(["дальний", "корень", "сосед"]);
  });

  it("обход не смотрит на направление ссылки", () => {
    // «сосед → корень», а не наоборот: на меня ссылаются — такая же связь.
    expect(neighborhood(graph, "корень", 1).nodes).toHaveLength(2);
  });

  it("несвязанный узел не попадает ни при каком радиусе", () => {
    expect(
      neighborhood(graph, "корень", 10).nodes.map((node) => node.id),
    ).not.toContain("чужой");
  });

  it("неизвестный корень даёт пустой граф", () => {
    expect(neighborhood(graph, "нет такого", 2)).toEqual({
      nodes: [],
      edges: [],
    });
  });
});

describe("createRandom", () => {
  it("одно зерно даёт одну и ту же последовательность", () => {
    const first = createRandom("владелец");
    const second = createRandom("владелец");

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it("разные зёрна расходятся", () => {
    expect(createRandom("a")()).not.toBe(createRandom("b")());
  });

  it("значения лежат в [0, 1)", () => {
    const random = createRandom("зерно");

    for (let index = 0; index < 1000; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
