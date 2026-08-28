import { describe, expect, it } from "vitest";

import { markdownExcerpt, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("рендерит обычный markdown", async () => {
    const html = await renderMarkdown("# Заголовок\n\nТекст с **жирным**.");
    expect(html).toContain("<h1>Заголовок</h1>");
    expect(html).toContain("<strong>жирным</strong>");
  });

  it("поддерживает GFM: таблицы и списки задач", async () => {
    const table = await renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(table).toContain("<table>");

    const tasks = await renderMarkdown("- [x] сделано\n- [ ] нет");
    expect(tasks).toContain('type="checkbox"');
  });

  // Публичная страница показывает чужой markdown, поэтому каждый вектор
  // проверяется отдельно.
  it("вырезает <script>", async () => {
    const html = await renderMarkdown('Текст <script>alert("xss")</script> дальше');
    // Тег исчезает; его содержимое остаётся обычным текстом внутри <p>
    // и выполниться уже не может.
    expect(html).not.toContain("<script");
    expect(html).toBe('<p>Текст alert("xss") дальше</p>');
  });

  it("вырезает inline-обработчики событий", async () => {
    const html = await renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });

  it("не пропускает javascript: в ссылках", async () => {
    const html = await renderMarkdown("[клик](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("не пропускает data: URI в картинках", async () => {
    const html = await renderMarkdown(
      "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    );
    expect(html).not.toContain("data:text/html");
  });

  it("вырезает <iframe>", async () => {
    const html = await renderMarkdown('<iframe src="https://example.com"></iframe>');
    expect(html).not.toContain("<iframe");
  });

  it("вырезает <style>", async () => {
    const html = await renderMarkdown("<style>body{display:none}</style>");
    expect(html).not.toContain("<style");
  });

  it("оставляет обычные внешние ссылки, но обезвреживает opener", async () => {
    const html = await renderMarkdown("[ссылка](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it("внутренние ссылки не открывает в новой вкладке", async () => {
    const html = await renderMarkdown("[заметка](/n/00000000-0000-4000-8000-000000000000)");
    expect(html).toContain('href="/n/00000000-0000-4000-8000-000000000000"');
    expect(html).not.toContain("target=");
  });
});

describe("markdownExcerpt", () => {
  it("убирает разметку", () => {
    expect(markdownExcerpt("# Заголовок\n\nТекст с **жирным**.")).toBe(
      "Заголовок Текст с жирным.",
    );
  });

  it("выкидывает блоки кода", () => {
    expect(markdownExcerpt("Было\n\n```js\nalert(1)\n```\n\nстало")).toBe("Было стало");
  });

  it("обрезает длинный текст", () => {
    expect(markdownExcerpt("а".repeat(300), 50)).toHaveLength(50);
  });
});
