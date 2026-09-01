"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import CodeMirror from "@uiw/react-codemirror";
import {
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  LinkIcon,
  LoaderIcon,
  LockIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NoteView } from "@/db/schema";
import { ApiError, apiFetch } from "@/lib/api-client";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

import { usePrefersDark } from "./use-prefers-dark";

/** Пауза без ввода, после которой уходит автосохранение. */
const AUTOSAVE_DELAY_MS = 800;

type SaveState = "saved" | "saving" | "dirty" | "error";

export function NoteEditor({ note }: { note: NoteView }) {
  const router = useRouter();
  const prefersDark = usePrefersDark();

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [visibility, setVisibility] = useState(note.visibility);
  const [saveState, setSaveState] = useState<SaveState>("saved");
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

    try {
      await apiFetch(`/api/notes/${note.id}`, { method: "PATCH", json: payload });
      savedRef.current = { title, content };
      setSaveState("saved");
      // Обновляем дерево слева: там мог измениться заголовок.
      if (payload.title !== undefined) router.refresh();
    } catch (cause) {
      setSaveState("error");
      toast.error(cause instanceof ApiError ? cause.message : "Не удалось сохранить.");
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
    try {
      const updated = await apiFetch<NoteView>(`/api/notes/${note.id}/${action}`, {
        method: "POST",
      });
      setVisibility(updated.visibility);
      toast.success(
        updated.visibility === "public"
          ? "Заметка опубликована — ссылка работает для всех."
          : "Заметка снова приватна.",
      );
      router.refresh();
    } catch (cause) {
      toast.error(
        cause instanceof ApiError ? cause.message : "Не удалось изменить доступ.",
      );
    }
  }

  return (
    // h-full, а не h-dvh: высоту задаёт колонка каркаса, и на телефоне
    // редактор не залезает под верхнюю полосу с кнопкой дерева.
    <div className="flex h-full min-h-0 flex-col">
      {/*
        Узкий экран — шапка в две строки: название отдельно, под ним ряд кнопок,
        прижатый вправо. Раньше всё лежало в одном flex-wrap, и кнопки скакали
        между строками при каждой смене подписи: «Превью» → «Скрыть превью»,
        появление «Копировать ссылку» после публикации.

        sm:contents растворяет обе обёртки на широком экране — там раскладка
        остаётся одной строкой.
      */}
      <header className="flex flex-col gap-2 border-b px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
        {/* Поле без рамки: это заголовок страницы, а не форма. Рамка
            проявляется по наведению и фокусу — чтобы было видно, что оно
            редактируемое. flex-1 только с sm: в колонке он растянул бы поле
            по высоте. */}
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void save()}
          aria-label="Название заметки"
          className="h-9 w-full border-transparent font-heading text-lg font-semibold shadow-none hover:border-input md:text-lg dark:bg-transparent sm:w-auto sm:min-w-40 sm:flex-1"
        />

        <div className="flex items-center justify-between gap-2 sm:contents">
          <SaveIndicator state={saveState} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 border-b">
        {/* На узком экране превью заменяет редактор, а не делит с ним ширину:
            две колонки по ~180px не годятся ни для правки, ни для чтения. */}
        <div
          className={cn(
            "min-w-0 flex-1 overflow-auto",
            showPreview && "hidden md:block",
          )}
        >
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
          <div className="min-w-0 flex-1 overflow-auto md:border-l">
            <MarkdownPreview source={content} />
          </div>
        )}
      </div>
      <footer>
        {/*
          Кнопки прижаты к правому краю, поэтому растущая подпись у левой из
          них не сдвигает соседей справа. Если ряд всё же не поместится —
          горизонтальная прокрутка, а не перенос на новую строку.
        */}
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto p-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPreview((value) => !value)}
          >
            {showPreview ? <EyeOffIcon /> : <EyeIcon />}
            {showPreview ? "Скрыть превью" : "Превью"}
          </Button>

          <Button
            variant={visibility === "public" ? "secondary" : "outline"}
            size="sm"
            onClick={() => void toggleVisibility()}
            className={cn(visibility === "public" && "text-success")}
          >
            {visibility === "public" ? <GlobeIcon /> : <LockIcon />}
            {visibility === "public" ? "Опубликована" : "Опубликовать"}
          </Button>

          {visibility === "public" && <CopyLinkButton noteId={note.id} />}
        </div>
      </footer>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { label, icon } = {
    saved: { label: "Сохранено", icon: <CheckIcon /> },
    saving: { label: "Сохранение…", icon: <LoaderIcon className="animate-spin" /> },
    dirty: { label: "Есть изменения", icon: null },
    error: { label: "Ошибка сохранения", icon: <TriangleAlertIcon /> },
  }[state];

  return (
    <span
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-xs [&_svg]:size-3.5",
        state === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

function CopyLinkButton({ noteId }: { noteId: string }) {
  const [copied, setCopied] = useState(false);

  // min-w держит ширину по длинной подписи: иначе на две секунды, пока висит
  // «Скопировано», кнопка сжималась бы и утаскивала за собой соседей слева.
  return (
    <Button
      variant="outline"
      size="sm"
      className="min-w-40"
      onClick={async () => {
        await navigator.clipboard.writeText(`${window.location.origin}/n/${noteId}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      {copied ? "Скопировано" : "Копировать ссылку"}
    </Button>
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
      className="prose prose-neutral dark:prose-invert max-w-none p-4 sm:p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
