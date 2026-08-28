import { describe, expect, it } from "vitest";

import {
  DEFAULT_POSITION,
  positionBetween,
  rebalancedPositions,
} from "./position";

describe("positionBetween", () => {
  it("даёт стартовую позицию для пустого списка", () => {
    expect(positionBetween(null, null)).toEqual({
      position: DEFAULT_POSITION,
      needsRebalance: false,
    });
  });

  it("добавляет в конец с шагом 1000", () => {
    expect(positionBetween("1000", null).position).toBe("2000");
    expect(positionBetween("2000", null).position).toBe("3000");
  });

  it("вставляет в начало половиной первой позиции", () => {
    expect(positionBetween(null, "1000").position).toBe("500");
  });

  it("вставляет ровно между соседями", () => {
    expect(positionBetween("1000", "2000").position).toBe("1500");
    expect(positionBetween("1000", "1001").position).toBe("1000.5");
  });

  it("не теряет точность на десятом знаке", () => {
    // Обычный float здесь уже округлил бы до 1000.0000000005.
    expect(positionBetween("1000.0000000001", "1000.0000000003").position).toBe(
      "1000.0000000002",
    );
  });

  it("сообщает о необходимости ребалансировки, когда делить нечего", () => {
    const result = positionBetween("1000.0000000001", "1000.0000000002");
    expect(result.needsRebalance).toBe(true);
  });

  it("выдерживает 33 деления подряд и только потом просит ребалансировку", () => {
    let prev = "1000";
    const next = "1001";
    let divisions = 0;

    for (let i = 0; i < 100; i += 1) {
      const result = positionBetween(prev, next);
      if (result.needsRebalance) break;
      prev = result.position;
      divisions += 1;
    }

    // 10 знаков после запятой при зазоре 1 — это 10^10 шагов, log2 ≈ 33.
    expect(divisions).toBeGreaterThanOrEqual(33);
    expect(divisions).toBeLessThan(40);
  });

  it("помечает ребалансировку, если соседи переданы в неверном порядке", () => {
    expect(positionBetween("2000", "1000").needsRebalance).toBe(true);
  });
});

describe("rebalancedPositions", () => {
  it("раскладывает список ровными шагами", () => {
    expect(rebalancedPositions(3)).toEqual(["1000", "2000", "3000"]);
  });

  it("для пустого списка возвращает пустой массив", () => {
    expect(rebalancedPositions(0)).toEqual([]);
  });
});
