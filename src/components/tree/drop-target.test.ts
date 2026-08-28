import { describe, expect, it } from "vitest";

import type { TreeNode } from "@/db/queries/tree";

import { isDescendant, locate, resolveMove } from "./drop-target";

const folder = (id: string, position: string, children: TreeNode[] = []): TreeNode => ({
  kind: "folder",
  id,
  parentId: null,
  title: id,
  position,
  children,
});

const note = (id: string, position: string): TreeNode => ({
  kind: "note",
  id,
  folderId: null,
  title: id,
  position,
  visibility: "private",
  updatedAt: new Date(0),
});

/**
 *  root
 *  ├── A (1000)
 *  │   ├── A1 (1000)      папка
 *  │   ├── n-a1 (1000)    заметка
 *  │   └── n-a2 (2000)    заметка
 *  └── B (2000)
 */
const tree: TreeNode[] = [
  folder("A", "1000", [folder("A1", "1000"), note("n-a1", "1000"), note("n-a2", "2000")]),
  folder("B", "2000"),
];

describe("locate", () => {
  it("находит узел и его родителя", () => {
    expect(locate(tree, "n-a1")?.parentId).toBe("A");
    expect(locate(tree, "A")?.parentId).toBeNull();
  });

  it("в соседи берёт только узлы того же вида", () => {
    expect(locate(tree, "n-a1")?.siblings.map((s) => s.id)).toEqual(["n-a1", "n-a2"]);
  });
});

describe("isDescendant", () => {
  it("узнаёт потомка", () => {
    expect(isDescendant(tree, "A", "A1")).toBe(true);
  });

  it("соседняя ветка потомком не является", () => {
    expect(isDescendant(tree, "A", "B")).toBe(false);
  });
});

describe("resolveMove — бросок внутрь папки", () => {
  it("переносит заметку в другую папку без явной позиции", () => {
    expect(resolveMove(tree, "n-a1", { type: "into", folderId: "B" })).toEqual({
      targetFolderId: "B",
    });
  });

  it("переносит в корень", () => {
    expect(resolveMove(tree, "n-a1", { type: "into", folderId: null })).toEqual({
      targetFolderId: null,
    });
  });

  it("бросок в текущего родителя ничего не меняет", () => {
    expect(resolveMove(tree, "n-a1", { type: "into", folderId: "A" })).toBeNull();
  });

  it("папку в саму себя — нельзя", () => {
    expect(resolveMove(tree, "A", { type: "into", folderId: "A" })).toBeNull();
  });

  it("папку внутрь своего потомка — нельзя", () => {
    expect(resolveMove(tree, "A", { type: "into", folderId: "A1" })).toBeNull();
  });
});

describe("resolveMove — бросок перед узлом", () => {
  it("ставит заметку перед первой в списке", () => {
    expect(resolveMove(tree, "n-a2", { type: "before", nodeId: "n-a1" })).toEqual({
      targetFolderId: "A",
      position: "500",
    });
  });

  it("ставит папку перед другой папкой в корне", () => {
    expect(resolveMove(tree, "B", { type: "before", nodeId: "A" })).toEqual({
      targetFolderId: null,
      position: "500",
    });
  });

  it("заметку перед папкой — нельзя: они сортируются раздельно", () => {
    expect(resolveMove(tree, "n-a1", { type: "before", nodeId: "A1" })).toBeNull();
  });

  it("бросок на самого себя ничего не меняет", () => {
    expect(resolveMove(tree, "n-a1", { type: "before", nodeId: "n-a1" })).toBeNull();
  });

  it("узел уже стоит прямо перед целью — ничего не меняет", () => {
    expect(resolveMove(tree, "n-a1", { type: "before", nodeId: "n-a2" })).toBeNull();
  });

  it("считает позицию между соседями", () => {
    const wide: TreeNode[] = [
      folder("F", "1000", [note("x", "1000"), note("y", "2000"), note("z", "3000")]),
    ];

    expect(resolveMove(wide, "z", { type: "before", nodeId: "y" })).toEqual({
      targetFolderId: "F",
      position: "1500",
    });
  });
});
