import { describe, expect, it } from "vitest";

import { DEFAULT_LAYERS, parseLayers } from "./use-graph-layers";

/**
 * Разбор сохранённых слоёв.
 *
 * Проверяется именно он, а не хук: в localStorage попадает строка, и всё,
 * что может пойти не так, идёт не так на её разборе. Записал прошлый выпуск
 * приложения, поправили из консоли, хранилище обрезало запись на середине —
 * любой из этих случаев не должен стоить человеку сломанной карты.
 */

describe("слои карты из хранилища", () => {
  it("пустое хранилище даёт слои по умолчанию", () => {
    expect(parseLayers(null)).toEqual(DEFAULT_LAYERS);
    expect(parseLayers("")).toEqual(DEFAULT_LAYERS);
  });

  it("сохранённый выбор возвращается как есть", () => {
    const stored = { folders: false, similar: true, isolated: true };

    expect(parseLayers(JSON.stringify(stored))).toEqual(stored);
  });

  it("мусор вместо JSON не ломает карту", () => {
    expect(parseLayers("{не json")).toEqual(DEFAULT_LAYERS);
    expect(parseLayers("null")).toEqual(DEFAULT_LAYERS);
    expect(parseLayers('"строка"')).toEqual(DEFAULT_LAYERS);
    expect(parseLayers("[true]")).toEqual({ ...DEFAULT_LAYERS });
  });

  it("порченое поле теряет только себя", () => {
    // Каждый флаг проверяется поодиночке: испорченный similar не должен
    // уносить с собой настоящий folders.
    expect(parseLayers('{"folders":false,"similar":"да"}')).toEqual({
      folders: false,
      similar: DEFAULT_LAYERS.similar,
      isolated: DEFAULT_LAYERS.isolated,
    });
  });

  it("лишние поля не протекают наружу", () => {
    // Иначе в состояние компонента попало бы то, чего в GraphLayers нет.
    expect(parseLayers('{"folders":true,"чужое":42}')).toEqual(DEFAULT_LAYERS);
  });
});
