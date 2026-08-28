"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import CodeMirror from "@uiw/react-codemirror";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Note } from "@/db/schema";
import { ApiError, apiFetch } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";

import { usePrefersDark } from "./use-prefers-dark";

/** Пауза без ввода, после которой уходит автосохранение. */
const AUTOSAVE_DELAY_MS = 800;

type SaveState = "saved" | "saving" | "dirty" | "error";

export function NoteEditor({ note }: { note: Note }) {
  const router = useRouter();
  const prefersDark = usePrefersDark();

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [visibility, setVisibility] = useState(note.visibility);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  // Сравниваем с последним сохранённым состоянием, а не с исходным:
  // иначе после сохранения редактор навсегда остался бы «грязным».
  const savedRef = useRef({ title: note.title, content: note.content });

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages })],
    [],
  );

  const save = useCallback(async () => {
    const payload: { title?: string; content?: string } = {};
    if (title !== savedRef.current.title) payload.title = title;
    if (content !== savedRef.current.content) payload.content = content;
    if (Object.keys(payload).length === 0) return;

    setSaveState("saving");
    setError(null);

    try {
      await apiFetch(`/api/notes/${note.id}`, { method: "PATCH", json: payload });
      savedRef.current = { title, content };
      setSaveState("saved");
      // Обновляем дерево слева: там мог измениться заголовок.
      if (payload.title !== undefined) router.refresh();
    } catch (cause) {
      setSaveState("error");
      setError(cause instanceof ApiError ? cause.message : "Не удалось сохранить.");
    }
  }, [content, note.id, router, title]);

  useEffect(() => {
    if (title === savedRef.current.title && content === savedRef.current.content) {
      return;
    }

    setSaveState("dirty");
    const timer = setTimeout(save, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [content, save, title]);

  // Ctrl+S — сохранить немедленно, не дожидаясь паузы.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [save]);

  async function toggleVisibility() {
    const action = visibility === "public" ? "make-private" : "publish";
    setError(null);
    try {
      const updated = await apiFetch<Note>(`/api/notes/${note.id}/${action}`, {
        method: "POST",
      });
      setVisibility(updated.visibility);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Не удалось изменить доступ.");
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          className="min-w-40 flex-1 bg-transparent text-lg font-semibold outline-none"
          aria-label="Название заметки"
        />

        <SaveIndicator state={saveState} />

        <button
          type="button"
          onClick={() => setShowPreview((value) => !value)}
          className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-surface"
        >
          {showPreview ? "Скрыть превью" : "Превью"}
        </button>

        <button
          type="button"
          onClick={() => void toggleVisibility()}
          className={`cursor-pointer rounded-md border px-2 py-1 text-xs transition-colors ${
            visibility === "public"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-border hover:bg-surface"
          }`}
        >
          {visibility === "public" ? "Опубликована" : "Опубликовать"}
        </button>

        {visibility === "public" && <CopyLinkButton noteId={note.id} />}
      </header>

      {error && (
        <p className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          <CodeMirror
            value={content}
            onChange={setContent}
            extensions={extensions}
            theme={prefersDark ? "dark" : "light"}
            basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
            height="100%"
            className="h-full text-sm"
          />
        </div>

        {showPreview && (
          <div className="min-w-0 flex-1 overflow-auto border-l border-border">
            <MarkdownPreview source={content} />
          </div>
        )}
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = {
    saved: "Сохранено",
    saving: "Сохранение…",
    dirty: "Есть изменения",
    error: "Ошибка сохранения",
  }[state];

  return (
    <span
      className={`text-xs ${state === "error" ? "text-red-600 dark:text-red-400" : "text-muted"}`}
    >
      {label}
    </span>
  );
}

function CopyLinkButton({ noteId }: { noteId: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(`${window.location.origin}/n/${noteId}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-surface"
    >
      {copied ? "Скопировано" : "Копировать ссылку"}
    </button>
  );
}

/**
 * Превью использует ту же цепочку remark/rehype, что и публичная страница,
 * включая санитизацию. Одна реализация — один результат, без расхождений
 * между тем, что видит автор, и тем, что увидит читатель.
 */
function MarkdownPreview({ source }: { source: string }) {
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
      className="prose prose-neutral dark:prose-invert max-w-none p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
