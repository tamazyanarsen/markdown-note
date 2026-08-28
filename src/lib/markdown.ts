import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Root } from "hast";

/**
 * Рендер markdown в HTML на сервере.
 *
 * Две линии защиты от XSS, потому что на публичной странице показывается
 * чужой текст:
 *  1. remark-rehype без allowDangerousHtml — сырой HTML из markdown
 *     не превращается в разметку, а выбрасывается;
 *  2. rehype-sanitize по схеме, близкой к GitHub, — на случай, если
 *     первая линия однажды изменится.
 *
 * rehype-raw здесь не подключается намеренно: он вернул бы сырой HTML
 * обратно в дерево.
 */

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Атрибуты, которые дописывает hardenLinks ниже.
    a: [...(defaultSchema.attributes?.a ?? []), "target", "rel"],
  },
};

/** Внешние ссылки открываем в новой вкладке и не отдаём им window.opener. */
function hardenLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "a") return;

      const href = node.properties?.href;
      if (typeof href !== "string" || !/^https?:\/\//i.test(href)) return;

      node.properties = {
        ...node.properties,
        target: "_blank",
        // hast хранит пробельные атрибуты списком; stringify склеит их обратно.
        rel: ["nofollow", "noopener", "noreferrer"],
      };
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(hardenLinks)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

export async function renderMarkdown(source: string): Promise<string> {
  const file = await processor.process(source);
  return String(file);
}

/** Короткая выжимка для превью и meta description. */
export function markdownExcerpt(source: string, maxLength = 200): string {
  const plain = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Маркеры в начале строки — заголовки, цитаты, списки: они разделяют
    // блоки, поэтому заменяются пробелом.
    .replace(/^[ \t]*[#>]+[ \t]*/gm, " ")
    .replace(/^[ \t]*[-*+][ \t]+/gm, " ")
    // Инлайн-разметка склеивает слово: её убираем без пробела,
    // иначе «**жирным**.» превратилось бы в «жирным .».
    .replace(/[*_`~]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1)}…` : plain;
}
