"use client";

import { CornerUpLeftIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { NoteConnections as Connections } from "@/domain/connections";
import type { SearchHit } from "@/domain/search";
import { apiFetch } from "@/lib/api-client";

/**
 * Связи заметки под редактором: кто сюда ссылается и что похоже по смыслу.
 *
 * Два списка, а не один: обратную ссылку поставил человек, похожесть посчитал
 * косинус. Показывать их вперемешку значило бы выдавать догадку за факт.
 *
 * Запрос уходит один раз при открытии заметки и не повторяется на правках.
 * Бэклинки от правки этой заметки и не меняются — их ставят другие заметки;
 * похожие меняются, но перезапрашивать их на каждое нажатие клавиши значило
 * бы гонять векторный поиск вхолостую. Обновятся при следующем открытии.
 *
 * Пока ничего не пришло и когда связей нет — полоса не рисуется совсем:
 * пустой блок «Похожих нет» отнимал бы высоту у редактора ни за что.
 */
export function NoteConnections({ noteId }: { noteId: string }) {
  // Идентификатор хранится рядом с данными, а не сбрасывается отдельным
  // setState в теле эффекта: такой сброс вызывает каскадный рендер, и eslint
  // на него ругается справедливо. Ответ от прошлой заметки просто не совпадёт
  // по noteId и не покажется.
  const [loaded, setLoaded] = useState<{
    noteId: string;
    connections: Connections;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void apiFetch<Connections>(`/api/notes/${noteId}/connections`, {
      signal: controller.signal,
    })
      .then((connections) => setLoaded({ noteId, connections }))
      .catch(() => {
        // Связи — дополнение к странице, а не сама страница. Отказ здесь
        // не повод показывать ошибку поверх текста заметки.
      });

    return () => controller.abort();
  }, [noteId]);

  if (!loaded || loaded.noteId !== noteId) return null;

  const { backlinks, related } = loaded.connections;
  if (backlinks.length === 0 && related.length === 0) return null;

  return (
    <section
      aria-label="Связи заметки"
      className="shrink-0 space-y-1.5 border-b px-3 py-2 sm:px-4"
    >
      <ConnectionRow
        icon={<CornerUpLeftIcon />}
        label="Ссылаются сюда"
        hits={backlinks}
      />
      <ConnectionRow icon={<SparklesIcon />} label="Похожие" hits={related} />
    </section>
  );
}

function ConnectionRow({
  icon,
  label,
  hits,
}: {
  icon: React.ReactNode;
  label: string;
  hits: SearchHit[];
}) {
  if (hits.length === 0) return null;

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="flex shrink-0 items-center gap-1.5 pt-1 text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {/* Подпись прячется на узком экране: там ценнее сами заметки,
            а иконка уже говорит, какой это список. */}
        <span className="hidden sm:inline">{label}</span>
      </span>

      {/* Список размечен списком, и подпись продублирована в aria-label:
          на узком экране видимая подпись скрыта, и без неё «ссылаются сюда»
          и «похожие» звучали бы для скринридера одинаково. */}
      <ul
        aria-label={label}
        className="flex min-w-0 flex-1 flex-wrap gap-1.5"
      >
        {hits.map((hit) => (
          <li key={hit.id} className="min-w-0">
            <Link
              href={`/n/${hit.id}`}
              // Сниппет в title, а не рядом: строка связей должна оставаться
              // строкой, иначе она отъедает половину высоты редактора.
              title={hit.snippet || undefined}
              className="block max-w-56 truncate rounded-md border px-2 py-1 hover:bg-accent hover:text-accent-foreground"
            >
              {hit.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
