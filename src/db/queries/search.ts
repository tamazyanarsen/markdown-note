import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../client";
import { noteChunks, notes } from "../schema";

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

/**
 * То же самое, но для сравнения заметки с заметкой (findRelatedNotes).
 *
 * Отдельное число, а не переиспользование MAX_SEMANTIC_DISTANCE: там короткий
 * запрос сравнивается с длинным куском, здесь — длинный текст с длинным.
 * Измерено на bge-m3, восемь заметок и все 28 пар между ними:
 *
 *   пары по одной теме       0,32  0,45  0,45  0,51  0,53
 *   разные темы              0,49 … 0,71
 *   заведомо постороннее     0,57 и дальше
 *
 * Чистого зазора нет, в отличие от пары «запрос — кусок»: диапазоны
 * налезают друг на друга в районе 0,49–0,53. Это не дефект замера, а
 * свойство задачи — две заметки одного проекта похожи всегда, вопрос
 * только насколько.
 *
 * 0,55 стоит там, где кончаются настоящие пары (0,53) и начинается заведомо
 * постороннее (0,57). Перекос в сторону «лучше показать лишнее»: блок
 * дополняет заметку, и одна неточная подсказка дешевле пустой строки,
 * ради которой человек всё равно полезет искать руками. Сверху всё равно
 * стоит limit, так что мусора больше пяти штук не наберётся.
 *
 * Числа привязаны к модели. При смене провайдера мерить заново —
 * скрипт замера тривиальный: посчитать embeddingInput по десятку своих
 * заметок и вывести матрицу косинусных расстояний.
 */
const MAX_RELATED_DISTANCE = 0.55;

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

/**
 * Заметки, близкие по смыслу к заданной.
 *
 * Тот же векторный поиск, только запросом служит не текст человека, а куски
 * самой заметки: считаем расстояние каждой пары «кусок этой заметки — кусок
 * чужой», сворачиваем до лучшей пары на заметку и сортируем.
 *
 * Новых вызовов внешнего API здесь нет вообще — векторы уже посчитаны
 * поиском и лежат в note_chunks.
 *
 * Исходная заметка тоже проверяется на владельца (join sn), хотя это делает
 * и доменный слой: иначе запрос был бы верным только при верном вызове,
 * а по правилу из шапки файла фильтр обязан стоять внутри.
 */
export async function findRelatedNotes(
  ownerId: string,
  noteId: string,
  limit = 5,
): Promise<SemanticMatch[]> {
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
        c.embedding <=> s.embedding as distance
      from note_chunks s
      join notes sn on sn.id = s.note_id and sn.owner_id = ${ownerId}
      join note_chunks c on c.note_id <> s.note_id
      join notes n on n.id = c.note_id
      where s.note_id = ${noteId}
        and n.owner_id = ${ownerId}
        and n.is_archived = false
      order by n.id, c.embedding <=> s.embedding
    ) best
    where distance < ${MAX_RELATED_DISTANCE}
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

/**
 * Тексты кусков заданных заметок — контекст для генерации ответа.
 *
 * Сниппет из выдачи поиска для этого не годится: он обрезан до 200 символов
 * и существует, чтобы человек узнал заметку, а не чтобы модель могла на него
 * опереться.
 *
 * Владелец в условии, хотя список id уже пришёл из поиска по его же
 * заметкам: правило из шапки файла не делает исключений, а ошибка вызова
 * здесь означала бы чужой текст в ответе.
 */
export async function findChunksForNotes(
  ownerId: string,
  noteIds: string[],
): Promise<Array<{ noteId: string; text: string }>> {
  if (noteIds.length === 0) return [];

  const rows = await db
    .select({ noteId: noteChunks.noteId, text: noteChunks.text })
    .from(noteChunks)
    .innerJoin(notes, eq(notes.id, noteChunks.noteId))
    .where(and(inArray(noteChunks.noteId, noteIds), eq(notes.ownerId, ownerId)))
    .orderBy(noteChunks.noteId, noteChunks.chunkIndex);

  return rows;
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
 *
 * Начинается всё с блокировки строки заметки, и она делает сразу две вещи.
 *
 * Во-первых, разводит одновременные индексации. Их запускают и поиск, и
 * панель связей, и идут они запросто вместе: без блокировки delete первой
 * успевает лечь между delete и insert второй, и вторая падает на первичном
 * ключе note_chunks.
 *
 * Во-вторых, ловит исчезнувшую заметку. Векторы считаются секундами, и за это
 * время заметку могли удалить — тогда insert упал бы по внешнему ключу.
 * Индексировать то, чего больше нет, не нужно: это не ошибка, а «работы не
 * осталось», и молчаливый выход честнее записи в лог.
 */
export async function replaceNoteChunks(
  noteId: string,
  sourceHash: string,
  chunks: Array<{ text: string; embedding: number[] }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.id, noteId))
      .for("update");

    if (!note) return;

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
