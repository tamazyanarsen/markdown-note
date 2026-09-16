import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db, pool } from "@/db/client";
import { loadGraphData } from "@/db/queries/graph";
import { EMBEDDING_DIMENSIONS, noteLinks, users } from "@/db/schema";
import { createFolder } from "@/domain/folders";
import {
  getGraphData,
  getNoteNeighborhood,
  getSimilarEdges,
} from "@/domain/graph";
import { archiveNote, createNote } from "@/domain/notes";
import type { Embedder } from "@/domain/search";
import { buildGraph, splitIsolated, type BuildGraphOptions } from "@/lib/graph";

/**
 * Граф связей против настоящего Postgres.
 *
 * Сборку узлов и рёбер проверяет юнит-тест (src/lib/graph.test.ts). Здесь
 * проверяется то, чего он не видит: что в граф попадает ровно то, что
 * лежит в базе у этого владельца, — и ни строки больше.
 *
 * Отдельного внимания стоит граница владельца. У note_links нет колонки
 * владельца: связь принадлежит тому, чьи заметки соединяет, и проверяет
 * это сам запрос. Если джойн в loadGraphData перестанет фильтровать оба
 * конца, чужая заметка появится на чужом экране — и молча.
 *
 * Нужен настоящий Postgres — `npm run db:up`.
 */

const HEIDI = "b8888888-8888-4888-8888-888888888888";
const IVAN = "c9999999-9999-4999-8999-999999999999";

/** Темы подставного векторизатора — тот же приём, что в tests/related.test.ts. */
const TOPICS = [
  ["дробн", "numeric", "между соседями", "позици"],
  ["авторизац", "oauth", "провайдер входа"],
];

const embed: Embedder = async (texts) =>
  texts.map((text) => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const lower = text.toLowerCase();

    TOPICS.forEach((words, index) => {
      if (words.some((word) => lower.includes(word))) vector[index] = 1;
    });

    // Нулевой вектор недопустим: косинусное расстояние от него не определено.
    vector[EMBEDDING_DIMENSIONS - 1] = 0.01;

    return vector;
  });

beforeEach(async () => {
  await db.delete(users).where(inArray(users.id, [HEIDI, IVAN]));
  await db.insert(users).values([
    { id: HEIDI, email: "heidi-graph@example.com", isApproved: true },
    { id: IVAN, email: "ivan-graph@example.com", isApproved: true },
  ]);
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [HEIDI, IVAN]));
  await pool.end();
});

/**
 * Карта владельца так, как её увидит страница: строки из базы плюс сборка.
 *
 * Сборка живёт на клиенте (src/lib/graph.ts) и проверяется юнит-тестом, но
 * проверять выборку в отрыве от неё бессмысленно: наружу уходит результат
 * их связки.
 */
async function graphOf(ownerId: string, options: BuildGraphOptions = {}) {
  const { graph, isolated } = splitIsolated(
    buildGraph(await getGraphData(ownerId), options),
  );

  return { nodes: graph.nodes, edges: graph.edges, isolated };
}

type OwnerGraph = Awaited<ReturnType<typeof graphOf>>;

/** Рёбра одного вида как «источник→цель» — сравнивать списками удобнее. */
function edgesOf(graph: OwnerGraph, kind: "link" | "folder"): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.source}→${edge.target}`)
    .sort();
}

describe("граф связей", () => {
  it("ссылка в тексте становится ребром", async () => {
    const target = await createNote(HEIDI, { title: "Цель", folderId: null });
    const source = await createNote(HEIDI, {
      title: "Источник",
      folderId: null,
      content: `Подробности — в [цели](/n/${target.id}).`,
    });

    const graph = await graphOf(HEIDI);

    expect(edgesOf(graph, "link")).toEqual([`${source.id}→${target.id}`]);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      [source.id, target.id].sort(),
    );
  });

  it("чужие заметки в граф не попадают", async () => {
    const foreign = await createNote(IVAN, { title: "Чужая", folderId: null });
    const mine = await createNote(HEIDI, {
      title: "Своя",
      folderId: null,
      // Ссылку на чужой UUID написать можно — связью она не станет.
      content: `[чужая](/n/${foreign.id})`,
    });

    const graph = await graphOf(HEIDI);

    // Связи не возникло, поэтому своя заметка — одиночка, а чужой нет нигде.
    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.isolated.map((node) => node.id)).toEqual([mine.id]);
  });

  it("связь через границу владельца не показывается, даже если она есть в базе", async () => {
    // Предыдущий тест проверяет защиту на записи: replaceNoteLinks просто
    // не создаёт такую строку. Здесь она вставляется в обход домена —
    // единственный способ добраться до читающих проверок. Схема такую
    // строку не запрещает: у note_links нет колонки владельца.
    const mine = await createNote(HEIDI, { title: "Своя", folderId: null });
    const foreign = await createNote(IVAN, { title: "Чужая", folderId: null });

    await db
      .insert(noteLinks)
      .values({ sourceNoteId: mine.id, targetNoteId: foreign.id });

    // Рубежа два, и проверять надо оба по отдельности. Первый — джойн
    // в loadGraphData: ребро не должно даже прийти из базы. Второй —
    // buildGraph, который выбрасывает ребро в неизвестный узел. Каждый
    // в одиночку закрывает эту дыру, поэтому проверка только через граф
    // проходила бы и со сломанным запросом.
    expect((await loadGraphData(HEIDI)).links).toHaveLength(0);

    const graph = await graphOf(HEIDI);

    expect(graph.edges).toHaveLength(0);
    expect(graph.nodes.map((node) => node.id)).not.toContain(foreign.id);
    expect(graph.isolated.map((node) => node.id)).not.toContain(foreign.id);

    // И с другой стороны: у владельца цели чужой источник тоже не всплывает.
    // Это отдельная проверка, а не симметричная приписка — фильтр по
    // владельцу в джойне стоит на двух концах, и убрать можно любой.
    expect((await loadGraphData(IVAN)).links).toHaveLength(0);

    const foreignGraph = await graphOf(IVAN);

    expect(foreignGraph.edges).toHaveLength(0);
    expect(foreignGraph.nodes.map((node) => node.id)).not.toContain(mine.id);
  });

  it("чужая папка не даёт узла", async () => {
    await createFolder(IVAN, { title: "Чужая папка", parentId: null });
    await createNote(HEIDI, { title: "Своя", folderId: null });

    const graph = await graphOf(HEIDI);

    expect(graph.nodes.filter((node) => node.kind === "folder")).toHaveLength(0);
  });

  it("архивная заметка исчезает вместе со своим ребром", async () => {
    const target = await createNote(HEIDI, { title: "Цель", folderId: null });
    const source = await createNote(HEIDI, {
      title: "Источник",
      folderId: null,
      content: `[цель](/n/${target.id})`,
    });

    expect(edgesOf(await graphOf(HEIDI), "link")).toHaveLength(1);

    await archiveNote(HEIDI, source.id);

    const graph = await graphOf(HEIDI);

    // Строка в note_links при архивации остаётся — узла нет, значит
    // и ребра быть не должно. Цель осталась без связей и стала одиночкой.
    expect(graph.edges).toHaveLength(0);
    expect(graph.isolated.map((node) => node.id)).toEqual([target.id]);
    expect(graph.nodes).toHaveLength(0);
  });

  it("папки дают узлы и связывают заметки с деревом", async () => {
    const root = await createFolder(HEIDI, { title: "Корень", parentId: null });
    const child = await createFolder(HEIDI, {
      title: "Вложенная",
      parentId: root.id,
    });
    const note = await createNote(HEIDI, {
      title: "Внутри",
      folderId: child.id,
    });

    const graph = await graphOf(HEIDI);

    expect(edgesOf(graph, "folder")).toEqual(
      [`${child.id}→${root.id}`, `${note.id}→${child.id}`].sort(),
    );
  });

  it("без слоя папок остаются только заметки", async () => {
    const folder = await createFolder(HEIDI, { title: "Папка", parentId: null });
    await createNote(HEIDI, { title: "Внутри", folderId: folder.id });

    const graph = await graphOf(HEIDI, { folders: false });

    expect(graph.nodes.some((node) => node.kind === "folder")).toBe(false);
    expect(graph.edges).toHaveLength(0);
  });

  it("заметка без единой связи уходит в одиночки", async () => {
    const linked = await createNote(HEIDI, { title: "Цель", folderId: null });
    await createNote(HEIDI, {
      title: "Источник",
      folderId: null,
      content: `[цель](/n/${linked.id})`,
    });
    const alone = await createNote(HEIDI, { title: "Сама по себе", folderId: null });

    const graph = await graphOf(HEIDI);

    expect(graph.isolated.map((node) => node.id)).toEqual([alone.id]);
    expect(graph.nodes.map((node) => node.id)).not.toContain(alone.id);
  });

  it("степень узла считает все касающиеся его рёбра", async () => {
    const folder = await createFolder(HEIDI, { title: "Папка", parentId: null });
    const hub = await createNote(HEIDI, { title: "Центр", folderId: folder.id });

    await createNote(HEIDI, {
      title: "Раз",
      folderId: null,
      content: `[центр](/n/${hub.id})`,
    });
    await createNote(HEIDI, {
      title: "Два",
      folderId: null,
      content: `[центр](/n/${hub.id})`,
    });

    const graph = await graphOf(HEIDI);
    const node = graph.nodes.find((candidate) => candidate.id === hub.id)!;

    // Две входящие ссылки плюс ребро к своей папке.
    expect(node.degree).toBe(3);
  });

  it("слой похожих связывает заметки об одном, но не разные", async () => {
    const first = await createNote(HEIDI, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });
    const second = await createNote(HEIDI, {
      title: "Ребалансировка",
      folderId: null,
      content: "Когда зазор позиций становится меньше 1e-6.",
    });
    const other = await createNote(HEIDI, {
      title: "Вход",
      folderId: null,
      content: "OAuth и провайдер входа.",
    });

    const { pairs, semantic } = await getSimilarEdges(HEIDI, { embed });

    expect(semantic).toBe(true);

    // Пары свёрнуты в неупорядоченные, поэтому сравниваем так же.
    const key = [first.id, second.id].sort().join("↔");

    expect(pairs.map((pair) => [pair.sourceId, pair.targetId].join("↔"))).toEqual([
      key,
    ]);
    expect(pairs.flatMap((pair) => [pair.sourceId, pair.targetId])).not.toContain(
      other.id,
    );
  });

  it("чужая заметка в слой похожих не попадает", async () => {
    // Векторы чужих заметок лежат в той же note_chunks, и у неё, как и
    // у note_links, нет колонки владельца.
    await createNote(HEIDI, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });
    await createNote(IVAN, {
      title: "Тоже про позиции",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });

    // Векторы обоих владельцев считаются каждый в своём вызове.
    await getSimilarEdges(IVAN, { embed });

    expect((await getSimilarEdges(HEIDI, { embed })).pairs).toHaveLength(0);
  });

  it("без векторизатора слоя нет, и это не ошибка", async () => {
    // Пустой MWS_API_KEY — штатный режим, тот же приём, что
    // в tests/related.test.ts: слой просто не строится.
    const saved = process.env.MWS_API_KEY;
    process.env.MWS_API_KEY = "";

    try {
      await createNote(HEIDI, {
        title: "Заметка",
        folderId: null,
        content: "текст",
      });

      expect(await getSimilarEdges(HEIDI)).toEqual({
        pairs: [],
        semantic: false,
      });
    } finally {
      if (saved === undefined) delete process.env.MWS_API_KEY;
      else process.env.MWS_API_KEY = saved;
    }
  });

  it("окрестность заметки берёт соседей и соседей соседей", async () => {
    const far = await createNote(HEIDI, { title: "Дальняя", folderId: null });
    const middle = await createNote(HEIDI, {
      title: "Средняя",
      folderId: null,
      content: `[дальняя](/n/${far.id})`,
    });
    const root = await createNote(HEIDI, {
      title: "Корень",
      folderId: null,
      content: `[средняя](/n/${middle.id})`,
    });
    const stranger = await createNote(HEIDI, {
      title: "Ни при чём",
      folderId: null,
    });

    const graph = await getNoteNeighborhood(HEIDI, root.id);
    const ids = graph.nodes.map((node) => node.id).sort();

    expect(ids).toEqual([far.id, middle.id, root.id].sort());
    expect(ids).not.toContain(stranger.id);
  });

  it("окрестность не тянет соседей по папке", async () => {
    // Иначе двумя шагами через узел папки притянулись бы все её заметки,
    // и вопрос «с чем связана эта» утонул бы в ответе «вот всё, что рядом».
    const folder = await createFolder(HEIDI, { title: "Папка", parentId: null });
    const root = await createNote(HEIDI, { title: "Корень", folderId: folder.id });
    await createNote(HEIDI, { title: "Сосед по папке", folderId: folder.id });

    const graph = await getNoteNeighborhood(HEIDI, root.id);

    expect(graph.nodes.map((node) => node.id)).toEqual([root.id]);
    expect(graph.edges).toHaveLength(0);
  });

  it("окрестность берёт и похожих, когда её об этом просят", async () => {
    // Ссылок нет ни одной: всё, что появится в окрестности, придёт
    // от косинуса. Ради этого слой в мини-карте и заводился — у заметки
    // без ссылок она иначе всегда пуста.
    const root = await createNote(HEIDI, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), новая позиция — среднее между соседями",
    });
    const close = await createNote(HEIDI, {
      title: "Ребалансировка",
      folderId: null,
      content: "дробные позиции пересчитываются, когда зазор схлопывается",
    });
    const other = await createNote(HEIDI, {
      title: "Вход через провайдера",
      folderId: null,
      content: "oauth, провайдер входа, сессия в базе",
    });

    const graph = await getNoteNeighborhood(HEIDI, root.id, {
      similar: true,
      embed,
    });

    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      [root.id, close.id].sort(),
    );

    // Концы сравниваются множеством: пары сворачиваются least/greatest,
    // и какой из двух id окажется источником, решает не смысл, а сортировка.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].kind).toBe("similar");
    expect([graph.edges[0].source, graph.edges[0].target].sort()).toEqual(
      [root.id, close.id].sort(),
    );

    // Чужая тема не притянулась: слой не «все заметки», а те, что ближе
    // порога MAX_RELATED_DISTANCE.
    expect(graph.nodes.map((node) => node.id)).not.toContain(other.id);
  });

  it("без просьбы окрестность остаётся на ссылках", async () => {
    // Умолчание то же, что у buildGraph: смысловой слой стоит перебора
    // векторов и внешнего вызова, и включается он явно.
    await createNote(HEIDI, {
      title: "Порядок элементов",
      folderId: null,
      content: "position numeric(20,10), среднее между соседями",
    });
    const root = await createNote(HEIDI, {
      title: "Ребалансировка",
      folderId: null,
      content: "дробные позиции, numeric и зазор между соседями",
    });

    const graph = await getNoteNeighborhood(HEIDI, root.id, { embed });

    // Сама заметка в окрестности есть всегда — не хватает только рёбер,
    // которые дал бы косинус.
    expect(graph.nodes.map((node) => node.id)).toEqual([root.id]);
    expect(graph.edges).toHaveLength(0);
  });

  it("окрестность чужой заметки пуста, а не подсмотрена", async () => {
    const foreign = await createNote(IVAN, { title: "Чужая", folderId: null });
    await createNote(IVAN, {
      title: "Чужой сосед",
      folderId: null,
      content: `[чужая](/n/${foreign.id})`,
    });

    expect(await getNoteNeighborhood(HEIDI, foreign.id)).toEqual({
      nodes: [],
      edges: [],
    });
  });

  it("степень в окрестности считается по ней самой", async () => {
    // У «средней» в полном графе две связи, в вырезе радиуса 1 — одна.
    const far = await createNote(HEIDI, { title: "Дальняя", folderId: null });
    const middle = await createNote(HEIDI, {
      title: "Средняя",
      folderId: null,
      content: `[дальняя](/n/${far.id})`,
    });
    const root = await createNote(HEIDI, {
      title: "Корень",
      folderId: null,
      content: `[средняя](/n/${middle.id})`,
    });

    const near = await getNoteNeighborhood(HEIDI, root.id, { radius: 1 });
    const node = near.nodes.find((candidate) => candidate.id === middle.id)!;

    expect(near.nodes).toHaveLength(2);
    expect(node.degree).toBe(1);
  });

  it("пустая база даёт пустой граф, а не ошибку", async () => {
    expect(await graphOf(HEIDI)).toEqual({
      nodes: [],
      edges: [],
      isolated: [],
    });
  });
});
