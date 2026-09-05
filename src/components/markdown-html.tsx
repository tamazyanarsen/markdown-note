"use client";

import { useEffect, useState } from "react";

import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * Markdown, отрендеренный на клиенте.
 *
 * Цепочка remark/rehype здесь ровно та же, что у публичной страницы, включая
 * санитизацию. Одна реализация — один результат: превью автора совпадает
 * с тем, что увидит читатель, а ответ модели проходит ту же чистку, что
 * и чужой текст.
 *
 * Рендер асинхронный, поэтому первым кадром показывается пустота. Для превью
 * и ответа это незаметно, для страницы заметки не годится — там html считает
 * сервер и кеширует его в notes.content_html.
 */
export function MarkdownHtml({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;

    void renderMarkdown(source).then((result) => {
      if (!cancelled) setHtml(result);
    });

    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <article
      className={cn("prose prose-neutral dark:prose-invert max-w-none", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
