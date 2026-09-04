import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import { noteChunks } from "../schema";

/**
 * Запросы поиска.
 *
 * Общее правило для всех: фильтр по владельцу и по is_archived стоит
 * ВНУТРИ ранжирующего запроса, до limit. Отфильтровать чужое после выборки
 * top-N нельзя — top-N мог бы целиком состоять из чужих заметок, и владелец
 * получил бы пустую выдачу при живых совпадениях в своих.
 */

/** Сколько кандидатов берёт каждый способ поиска до слияния. */
export const CANDIDATE_LIMIT = 30;

/** Сколько символов заметки тянем на превью для полнотекстовых попаданий. */
const PREVIEW_CHARS = 400;

/**
 * Косинусное расстояние, дальше которого совпадение не считается совпадением.
 *
 * Векторный поиск всегда возвращает N ближайших соседей, каким бы далёким ни
 * оказался ближайший: понятия «ничего не подошло» у него нет. Без отсечки
 * запрос «рецепт борща» в базе про разработку вернул бы все заметки подряд.
 *
 * Значение измерено на bge-m3, шесть запросов против реальных заметок:
 * у релевантных ближайшее расстояние 0,38–0,55, у заведомо посторонних —
 * 0,67–0,75. Порог поставлен в зазор и смещён в сторону «лучше оставить
 * лишнее»: потерять нужную заметку хуже, чем показать одну ненужную,
 * а точные совпадения слов сюда и не попадают — их находит FTS отдельно.
 *
 * Число привязано к модели. При смене провайдера его надо перемерить:
 * шкалы у моделей разные, и 0,65 у другой может отсечь вообще всё.
 */
const MAX_SEMANTIC_DISTANCE = 0.65;

export interface LexicalMatch {
  id: string;
  title: string;
  folderId: string | null;
  /** Начало markdown-исходника: полный content тянуть нельзя, он до 512 КБ. */
  preview: string;
}

export interface SemanticMatch {
  id: string;
  title: string;
  folderId: string | null;
  /** Текст самого похожего куска — он же идёт в сниппет. */
  chunkText: string;
}

/**
 * Полнотекстовый поиск по notes.search_vector (GIN-индекс notes_search_idx).
 *
 * websearch_to_tsquery, а не plainto_: он переживает кавычки, минусы и OR
 * в пользовательском вводе, тогда как to_tsquery на них падает с ошибкой
 * синтаксиса — а сюда приходит то, что человек набрал в поле поиска.
 */
export async function findLexicalMatches(
  ownerId: string,
  query: string,
  limit = CANDIDATE_LIMIT,
): Promise<LexicalMatch[]> {
  const result = await db.execute<{
    id: string;
    title: string;
    folder_id: string | null;
    preview: string;
  }>(sql`
    select
      n.id,
      n.title,
      n.folder_id,
      left(n.content, ${PREVIEW_CHARS}) as preview
    from notes n,
      websearch_to_tsquery('russian', ${query}) as q
    where n.owner_id = ${ownerId}
      and n.is_archived = false
      and n.search_vector @@ q
    order by ts_rank(n.search_vector, q) desc, n.updated_at desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    folderId: row.folder_id,
    preview: row.preview,
  }));
}

/**
 * Векторный поиск по note_chunks.
 *
 * `<=>` — косинусное расстояние pgvector: меньше значит ближе. Индекса нет
 * намеренно (см. комментарий к noteChunks в схеме), это полный перебор.
 *
 * distinct on сворачивает заметку до её лучшего куска, внешний order by
 * расставляет уже сами заметки — без него отсортированы были бы куски.
 *
 * Слишком далёкие соседи отбрасываются по MAX_SEMANTIC_DISTANCE, иначе
 * бессмысленный запрос возвращал бы всю базу подряд.
 */
export async function findSemanticMatches(
  ownerId: string,
  embedding: number[],
  limit = CANDIDATE_LIMIT,
): Promise<SemanticMatch[]> {
  // pgvector принимает вектор в текстовом виде «[1,2,3]» — ровно то,
  // что даёт JSON.stringify для массива чисел.
  const vector = JSON.stringify(embedding);

  const result = await db.execute<{
    id: string;
    title: string;
    folder_id: string | null;
    chunk_text: string;
  }>(sql`
    select id, title, folder_id, chunk_text
    from (
      select distinct on (n.id)
        n.id,
        n.title,
        n.folder_id,
        c.text as chunk_text,
        c.embedding <=> ${vector}::vector as distance
      from note_chunks c
      join notes n on n.id = c.note_id
      where n.owner_id = ${ownerId}
        and n.is_archived = false
      order by n.id, c.embedding <=> ${vector}::vector
    ) best
    where distance < ${MAX_SEMANTIC_DISTANCE}
    order by distance
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    folderId: row.folder_id,
    chunkText: row.chunk_text,
  }));
}

export interface StaleNote {
  id: string;
  title: string;
  content: string;
  /** Хеш, посчитанный базой — его же и запишем обратно. */
  sourceHash: string;
}

/**
 * Заметки, чьи векторы отстали от текста.
 *
 * Устаревание определяется сравнением хешей, а не флагом «переиндексировать»:
 * флаг можно рассинхронизировать с данными (упавшая запись, правка мимо
 * приложения), а хеш — нет. Заметка без единого куска попадает сюда же.
 *
 * limit не для производительности запроса, а для размера ответа: content
 * бывает до 512 КБ, и первый в жизни поиск иначе поднял бы в память всю базу.
 * Остаток доиндексируется следующими поисками — состояние самовыравнивается.
 */
export async function findStaleNotes(
  ownerId: string,
  limit = 50,
): Promise<StaleNote[]> {
  const result = await db.execute<{
    id: string;
    title: string;
    content: string;
    source_hash: string;
  }>(sql`
    select n.id, n.title, n.content, md5(n.title || n.content) as source_hash
    from notes n
    where n.owner_id = ${ownerId}
      and n.is_archived = false
      and not exists (
        select 1
        from note_chunks c
        where c.note_id = n.id
          and c.source_hash = md5(n.title || n.content)
      )
    order by n.updated_at desc
    limit ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    sourceHash: row.source_hash,
  }));
}

/**
 * Переписывает куски заметки целиком.
 *
 * Транзакция обязательна: между delete и insert заметка осталась бы
 * ненайденной, а при падении вставки — ненайденной навсегда.
 *
 * sourceHash приходит тот, из которого считались векторы. Если текст успел
 * измениться, следующий поиск снова увидит расхождение и пересчитает —
 * та же защита от гонки, что у saveNoteHtml в src/domain/notes.ts.
 */
export async function replaceNoteChunks(
  noteId: string,
  sourceHash: string,
  chunks: Array<{ text: string; embedding: number[] }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(noteChunks).where(eq(noteChunks.noteId, noteId));

    if (chunks.length === 0) return;

    await tx.insert(noteChunks).values(
      chunks.map((chunk, index) => ({
        noteId,
        chunkIndex: index,
        sourceHash,
        text: chunk.text,
        embedding: chunk.embedding,
      })),
    );
  });
}
