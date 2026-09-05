import { describe, expect, it } from "vitest";

import { extractNoteLinks } from "./links";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("extractNoteLinks", () => {
  it("находит относительную ссылку на заметку", () => {
    expect(extractNoteLinks(`Смотри [заметку](/n/${A}) рядом.`)).toEqual([A]);
  });

  it("находит ссылку, скопированную из адресной строки целиком", () => {
    // Копировать адрес открытой заметки проще, чем набирать `[[`,
    // поэтому абсолютная форма должна работать наравне с относительной.
    const text = `[заметка](https://notes.example.com/n/${A})`;
    expect(extractNoteLinks(text)).toEqual([A]);
  });

  it("переживает якорь и параметры в адресе", () => {
    expect(extractNoteLinks(`[раздел](/n/${A}#section)`)).toEqual([A]);
  });

  it("не считает ссылкой пример внутри блока кода", () => {
    // Ровно за этим здесь разбор AST, а не регулярка по всему тексту.
    const text = ["Пример разметки:", "", "```md", `[текст](/n/${A})`, "```"].join(
      "\n",
    );

    expect(extractNoteLinks(text)).toEqual([]);
  });

  it("не считает связью картинку", () => {
    expect(extractNoteLinks(`![картинка](/n/${A})`)).toEqual([]);
  });

  it("понимает справочную форму ссылки", () => {
    const text = `Смотри [заметку][ref].\n\n[ref]: /n/${A}`;
    expect(extractNoteLinks(text)).toEqual([A]);
  });

  it("не повторяет одну и ту же цель дважды", () => {
    const text = `[раз](/n/${A}) и ещё [два](/n/${A})`;
    expect(extractNoteLinks(text)).toEqual([A]);
  });

  it("приводит UUID к нижнему регистру", () => {
    expect(extractNoteLinks(`[з](/n/${A.toUpperCase()})`)).toEqual([A]);
  });

  it("выбрасывает ссылку заметки на саму себя", () => {
    const text = `[сюда же](/n/${A}) и [туда](/n/${B})`;
    expect(extractNoteLinks(text, A)).toEqual([B]);
  });

  it("не принимает за ссылку посторонние адреса", () => {
    const text = `[внешняя](https://example.com/page) и [файл](/api/files/${A})`;
    expect(extractNoteLinks(text)).toEqual([]);
  });

  it("пустой текст даёт пустой список", () => {
    expect(extractNoteLinks("")).toEqual([]);
  });
});
