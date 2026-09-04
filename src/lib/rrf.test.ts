import { describe, expect, it } from "vitest";

import { fuseByRrf, RRF_K } from "./rrf";

describe("fuseByRrf", () => {
  it("пустой ввод даёт пустой результат", () => {
    expect(fuseByRrf([])).toEqual([]);
    expect(fuseByRrf([[], []])).toEqual([]);
  });

  it("единственный список сохраняет свой порядок", () => {
    // Ровно этот случай возникает, когда внешний API недоступен:
    // остаётся только полнотекстовая выдача, и портить её нельзя.
    const fused = fuseByRrf([["a", "b", "c"]]);

    expect(fused.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("поднимает заметку, найденную обоими списками, над лидерами одного", () => {
    // Ради этого весь RRF и нужен: «b» не первая ни там, ни там, но
    // встретилась дважды — 2/(60+2) против 1/(60+1) у «a» и у «c».
    // Заметка, которую независимо нашли и слова, и смысл, важнее той,
    // что понравилась только одному из способов.
    const fused = fuseByRrf([
      ["a", "b"],
      ["c", "b"],
    ]);

    expect(fused[0].id).toBe("b");
  });

  it("считает вклад места как 1/(k + позиция)", () => {
    const [first, second] = fuseByRrf([["x", "y"]]);

    expect(first.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(second.score).toBeCloseTo(1 / (RRF_K + 2), 12);
  });

  it("не засчитывает повтор внутри одного списка дважды", () => {
    const [item] = fuseByRrf([["a", "a", "a"]]);

    expect(item.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("при равных очках упорядочивает по id, а не как придётся", () => {
    // Иначе один и тот же запрос давал бы разный порядок выдачи.
    const fused = fuseByRrf([
      ["b", "a"],
      ["a", "b"],
    ]);

    expect(fused.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
