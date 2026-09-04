"use client";

import { FileTextIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
 */

/** Полнотекстовый запрос: почти сразу, лишь бы не бить на каждый символ. */
const FTS_DELAY_MS = 120;

/** Смысловой: только когда человек действительно остановился. */
const HYBRID_DELAY_MS = 400;

/** Короче двух символов не ищем — так же считает searchQuerySchema. */
const MIN_QUERY_LENGTH = 2;

export function SearchPalette() {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, setPending] = useState(false);

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
  }, [query]);

  const openNote = useCallback(
    (noteId: string) => {
      setOpen(false);
      router.push(`/n/${noteId}`);
    },
    [router],
  );

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
    }
  };

  const trimmed = query.trim();

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
        {/* shouldFilter отключён: ранжирует сервер, и порядок из RRF
            нельзя пересортировывать на клиенте по совпадению подстроки. */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={onQueryChange}
            placeholder="Найти заметку по смыслу…"
          />

          <CommandList>
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
      </CommandDialog>
    </>
  );
}
