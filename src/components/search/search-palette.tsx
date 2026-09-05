"use client";

import {
  ArrowLeftIcon,
  FileTextIcon,
  LoaderIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { MarkdownHtml } from "@/components/markdown-html";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import type { AskResult } from "@/domain/ask";
import type { SearchHit, SearchResult } from "@/domain/search";
import { apiFetch } from "@/lib/api-client";

/**
 * Поиск по заметкам — палитра поверх интерфейса, Ctrl/Cmd + K.
 *
 * Запрос уходит дважды. Сначала полнотекстовый: он локальный и бесплатный,
 * поэтому список появляется практически сразу и поиск ощущается мгновенным.
 * Затем, если человек перестал печатать, — смысловой: он дороже и ходит во
 * внешний API, зато находит заметку, в которой нет ни одного слова из запроса.
 *
 * Платить вызовом API за каждое нажатие клавиши нельзя, отсюда две паузы
 * вместо одной.
 *
 * Отдельным пунктом сверху — вопрос к заметкам: та же выдача, но пересказанная
 * моделью со ссылками на источники. Он не подмешивается в список, а переводит
 * палитру в другой режим: генерация занимает секунды, и подмена списка
 * ответом на месте выглядела бы зависанием.
 */

/** Полнотекстовый запрос: почти сразу, лишь бы не бить на каждый символ. */
const FTS_DELAY_MS = 120;

/** Смысловой: только когда человек действительно остановился. */
const HYBRID_DELAY_MS = 400;

/** Короче двух символов не ищем — так же считает searchQuerySchema. */
const MIN_QUERY_LENGTH = 2;

/** Короче трёх символов не спрашиваем — так же считает askSchema. */
const MIN_QUESTION_LENGTH = 3;

export function SearchPalette({ chatEnabled = false }: { chatEnabled?: boolean }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, setPending] = useState(false);

  /** Заданный вопрос. null — палитра в обычном режиме поиска. */
  const [question, setQuestion] = useState<string | null>(null);
  /** Ответ на него. null при заданном вопросе — ещё думаем. */
  const [answer, setAnswer] = useState<AskResult | null>(null);

  // Ответ приходит секундами позже вопроса. За это время палитру могли
  // закрыть или спросить другое — тогда пришедший ответ уже не наш.
  const askId = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;

      // Без этого Chrome и Firefox уведут фокус в адресную строку:
      // Ctrl+K у них — «поиск в вебе».
      event.preventDefault();
      setOpen((value) => !value);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    // В режиме ответа поиск не нужен: список всё равно не показывается,
    // а запросы продолжали бы уходить на каждое изменение строки.
    if (question !== null) return;

    const trimmed = query.trim();

    // Слишком короткий запрос гасится в обработчике ввода, а не здесь:
    // синхронный setState в теле эффекта вызывает каскадный рендер.
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    const controller = new AbortController();
    let cancelled = false;

    // Гибридный ответ не должен затираться полнотекстовым, если тот придёт
    // вторым: сеть не обещает порядок, а откат к худшей выдаче виден глазом.
    let answered: "none" | "fts" | "hybrid" = "none";

    const run = async (mode: "fts" | "hybrid") => {
      try {
        const result = await apiFetch<SearchResult>(
          `/api/search?q=${encodeURIComponent(trimmed)}&mode=${mode}`,
          { signal: controller.signal },
        );

        if (cancelled) return;
        if (mode === "fts" && answered === "hybrid") return;

        answered = mode;
        setHits(result.hits);
      } catch {
        // Запрос отменён сменой строки либо API отказал. В обоих случаях
        // молчим: сообщать не о чем, прежний список остаётся на экране.
      } finally {
        if (!cancelled && mode === "hybrid") setPending(false);
      }
    };

    const fastTimer = setTimeout(() => {
      setPending(true);
      void run("fts");
    }, FTS_DELAY_MS);

    const slowTimer = setTimeout(() => void run("hybrid"), HYBRID_DELAY_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(fastTimer);
      clearTimeout(slowTimer);
    };
  }, [query, question]);

  const openNote = useCallback(
    (noteId: string) => {
      setOpen(false);
      router.push(`/n/${noteId}`);
    },
    [router],
  );

  const ask = useCallback(async (asked: string) => {
    const id = ++askId.current;

    setQuestion(asked);
    setAnswer(null);

    try {
      const result = await apiFetch<AskResult>("/api/ask", {
        method: "POST",
        json: { q: asked },
      });

      if (askId.current === id) setAnswer(result);
    } catch {
      // Показываем то же, что и при отказе модели: пустой ответ без
      // источников. Отдельного текста ошибки здесь не нужно — карточка
      // ниже сама объяснит, что пересказа не будет.
      if (askId.current === id) setAnswer({ answer: null, sources: [] });
    }
  }, []);

  const backToSearch = useCallback(() => {
    // Сдвигаем счётчик: ответ на брошенный вопрос не должен всплыть,
    // когда человек уже вернулся к списку.
    askId.current += 1;
    setQuestion(null);
    setAnswer(null);
  }, []);

  const onQueryChange = (value: string) => {
    setQuery(value);

    // Стёрли запрос до пары символов — выдача от прошлого запроса больше
    // ни к чему не относится, убираем сразу.
    if (value.trim().length < MIN_QUERY_LENGTH) {
      setHits([]);
      setPending(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);

    // Закрыли — забываем всё: открывать палитру с прошлым запросом
    // и чужой выдачей неожиданно.
    if (!next) {
      setQuery("");
      setHits([]);
      setPending(false);
      backToSearch();
    }
  };

  const trimmed = query.trim();
  const canAsk = chatEnabled && trimmed.length >= MIN_QUESTION_LENGTH;

  return (
    <>
      {/* Видимая точка входа. Без неё поиск существовал бы только для тех,
          кто угадал сочетание клавиш. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <SearchIcon className="size-4" />
        <span className="hidden sm:inline">Поиск</span>
        <kbd className="hidden rounded border bg-muted px-1 font-mono text-[10px] sm:inline">
          Ctrl K
        </kbd>
      </button>

      <CommandDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Поиск по заметкам"
        description="Введите запрос. Поиск понимает смысл, а не только совпадение слов."
        className="sm:max-w-xl"
      >
        {question !== null ? (
          <AnswerView
            question={question}
            result={answer}
            onBack={backToSearch}
            onOpenNote={openNote}
          />
        ) : (
          /* shouldFilter отключён: ранжирует сервер, и порядок из RRF
             нельзя пересортировывать на клиенте по совпадению подстроки. */
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={onQueryChange}
              placeholder={
                chatEnabled
                  ? "Найти заметку или задать вопрос…"
                  : "Найти заметку по смыслу…"
              }
            />

            <CommandList>
              {canAsk && (
                <CommandItem
                  // Значение не пересекается с UUID заметок, поэтому пункт
                  // не спутается с результатом при навигации стрелками.
                  value="ask"
                  onSelect={() => void ask(trimmed)}
                  className="items-start gap-2"
                >
                  <SparklesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      Спросить у заметок
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      «{trimmed}»
                    </span>
                  </span>
                </CommandItem>
              )}

              {hits.map((hit) => (
                <CommandItem
                  key={hit.id}
                  // value — id, а не заголовок: заголовки повторяются,
                  // и cmdk путал бы одинаковые строки между собой.
                  value={hit.id}
                  onSelect={() => openNote(hit.id)}
                  className="items-start gap-2"
                >
                  <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {hit.title}
                    </span>
                    {hit.snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                        {hit.snippet}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}

              {hits.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {trimmed.length < MIN_QUERY_LENGTH
                    ? "Введите хотя бы два символа."
                    : pending
                      ? "Ищу…"
                      : "Ничего не нашлось."}
                </p>
              )}
            </CommandList>
          </Command>
        )}
      </CommandDialog>
    </>
  );
}

/**
 * Режим ответа.
 *
 * Пока ответ не пришёл, на экране индикатор с прямым предупреждением, что это
 * секунды: без него пауза в пять секунд читается как зависшая палитра.
 *
 * Источники показываются всегда, даже когда пересказа нет: найденные заметки
 * полезны сами по себе, а «ответа не будет» без них выглядело бы как «поиск
 * ничего не нашёл» — хотя нашёл.
 */
function AnswerView({
  question,
  result,
  onBack,
  onOpenNote,
}: {
  question: string;
  result: AskResult | null;
  onBack: () => void;
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
          <ArrowLeftIcon />
          К поиску
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={question}>
          {question}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {result === null ? (
          <p
            role="status"
            className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
          >
            <LoaderIcon className="size-4 animate-spin" />
            Читаю заметки и собираю ответ — это несколько секунд.
          </p>
        ) : (
          <>
            {result.answer ? (
              // Ответ модели проходит ту же санитизацию, что и чужой markdown.
              <MarkdownHtml source={result.answer} className="prose-sm" />
            ) : (
              <p className="text-sm text-muted-foreground">
                {result.sources.length > 0
                  ? "Пересказ не получился — модель не настроена или не ответила. Вот заметки, которые нашлись по вопросу."
                  : "По этому вопросу ничего не нашлось."}
              </p>
            )}

            {result.sources.length > 0 && (
              <div className="mt-4 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Источники
                </p>
                {result.sources.map((hit, index) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => onOpenNote(hit.id)}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                  >
                    {/* Номер совпадает со ссылками вида [1] внутри ответа. */}
                    <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">
                      [{index + 1}]
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{hit.title}</span>
                      {hit.snippet && (
                        <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                          {hit.snippet}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
