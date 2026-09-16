import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { GraphData, GraphLinkRow } from "@/lib/graph";

import { db } from "../client";
import { folders, noteLinks, notes } from "../schema";
import { MAX_RELATED_DISTANCE } from "./search";

/**
 * Сырые данные для графа связей.
 *
 * Три плоских списка, из которых src/lib/graph.ts собирает узлы и рёбра.
 * Разделение такое же, как у дерева: база отдаёт строки, иерархию и
 * производные величины считает чистый код, который можно проверить
 * юнит-тестом без Postgres.
 *
 * content не выбирается нигде: в графе он не нужен, а весит до 512 КБ
 * на заметку (LIMITS.contentMaxLength). Всё, что рисуется, — заголовок.
 *
 * Формы строк объявлены в src/lib/graph.ts, а не здесь: там они и
 * потребляются, и тамошние функции не должны знать про базу вообще.
 */

/**
 * Всё, из чего строится личный граф владельца.
 *
 * Три запроса параллельно: они независимы, а связность проверяется уже
 * в памяти — ссылка на заметку, которой нет в выборке, просто выпадет.
 *
 * Порядок всюду по id, а не по position. Раскладка графа детерминирована
 * (см. seed в src/lib/graph.ts), но силы накапливаются в порядке обхода
 * массивов — значит и он обязан не зависеть от того, что заметку
 * перетащили в дереве. По position сортируется дерево, здесь позиция
 * не значит ничего.
 */
export async function loadGraphData(ownerId: string): Promise<GraphData> {
  // note_links не знает, чьи заметки связаны: владельца проверяет запрос,
  // и это не оптимизация, а единственная защита (см. комментарий к таблице
  // в схеме). Поэтому джойна два — на источник и на цель, — и условие по
  // owner_id стоит у обоих. Убрать одно значит пустить в граф чужую заметку.
  const source = alias(notes, "source_note");
  const target = alias(notes, "target_note");

  const [noteRows, folderRows, linkRows] = await Promise.all([
    db
      .select({
        id: notes.id,
        title: notes.title,
        folderId: notes.folderId,
        updatedAt: notes.updatedAt,
      })
      .from(notes)
      .where(and(eq(notes.ownerId, ownerId), eq(notes.isArchived, false)))
      .orderBy(asc(notes.id)),

    db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        title: folders.title,
      })
      .from(folders)
      .where(and(eq(folders.ownerId, ownerId), eq(folders.isArchived, false)))
      .orderBy(asc(folders.id)),

    db
      .select({
        sourceId: noteLinks.sourceNoteId,
        targetId: noteLinks.targetNoteId,
      })
      .from(noteLinks)
      .innerJoin(source, eq(source.id, noteLinks.sourceNoteId))
      .innerJoin(target, eq(target.id, noteLinks.targetNoteId))
      .where(
        and(
          eq(source.ownerId, ownerId),
          eq(target.ownerId, ownerId),
          // Архивная заметка не видна в дереве — ребра из небытия в графе
          // тоже быть не должно. То же правило, что в findBacklinks.
          eq(source.isArchived, false),
          eq(target.isArchived, false),
        ),
      )
      .orderBy(asc(noteLinks.sourceNoteId), asc(noteLinks.targetNoteId)),
  ]);

  return { notes: noteRows, folders: folderRows, links: linkRows };
}

/**
 * Сколько ближайших соседей берётся у каждой заметки.
 *
 * Без ограничения плотное скопление похожих заметок дало бы полный граф
 * внутри себя: десять заметок об одном — это сорок пять рёбер, и на экране
 * они сливаются в кляксу. Три соседа оставляют форму скопления видимой.
 */
const SIMILAR_PER_NOTE = 3;

/**
 * Пары близких по смыслу заметок — слой «похожие» на карте.
 *
 * Тот же механизм, что у блока «Похожие» под заметкой (findRelatedNotes),
 * только сразу для всех: расстояние между лучшими кусками каждой пары,
 * отсечка по MAX_RELATED_DISTANCE, ближайшие SIMILAR_PER_NOTE у каждой.
 *
 * Внешний API здесь не участвует: векторы уже посчитаны и лежат
 * в note_chunks. Заметка, до которой индексация ещё не дошла, просто
 * не даст ни одного ребра.
 *
 * Пары свёрнуты в неупорядоченные (least/greatest): похожесть взаимна,
 * и два ребра вместо одного только удвоили бы степень обоих узлов.
 * Отбор при этом идёт до свёртки — заметка попадает в соседи, если
 * входит в тройку ближайших хотя бы с одной стороны.
 */
export async function loadSimilarPairs(
  ownerId: string,
): Promise<GraphLinkRow[]> {
  const result = await db.execute<{ source_id: string; target_id: string }>(sql`
    select distinct
      least(source_id, target_id) as source_id,
      greatest(source_id, target_id) as target_id
    from (
      select
        source_id,
        target_id,
        row_number() over (partition by source_id order by distance) as rank
      from (
        select distinct on (s.note_id, c.note_id)
          s.note_id as source_id,
          c.note_id as target_id,
          c.embedding <=> s.embedding as distance
        from note_chunks s
        join notes sn on sn.id = s.note_id
        join note_chunks c on c.note_id <> s.note_id
        join notes n on n.id = c.note_id
        -- Владелец проверяется у обеих заметок пары, как и у ссылок:
        -- note_chunks, как и note_links, не знает, чьи это заметки.
        where sn.owner_id = ${ownerId}
          and sn.is_archived = false
          and n.owner_id = ${ownerId}
          and n.is_archived = false
        order by s.note_id, c.note_id, c.embedding <=> s.embedding
      ) pairs
      where distance < ${MAX_RELATED_DISTANCE}
    ) ranked
    where rank <= ${SIMILAR_PER_NOTE}
    order by 1, 2
  `);

  return result.rows.map((row) => ({
    sourceId: row.source_id,
    targetId: row.target_id,
  }));
}
