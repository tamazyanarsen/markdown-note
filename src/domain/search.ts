import {
  findLexicalMatches,
  findRelatedNotes,
  findSemanticMatches,
  findStaleNotes,
  replaceNoteChunks,
  type LexicalMatch,
  type SemanticMatch,
} from "@/db/queries/search";
import { embeddingInput, splitIntoChunks } from "@/lib/chunk";
import { embedTexts, isSemanticEnabled } from "@/lib/embeddings";
import { markdownExcerpt } from "@/lib/markdown";
import { fuseByRrf } from "@/lib/rrf";

/**
 * Поиск по своим заметкам.
 *
 * Гибрид, а не только смысловой слой. Векторный поиск систематически мажет
 * по точным терминам — «OAuthAccountNotLinked» он размывает в «что-то про
 * авторизацию», — а полнотекстовый слеп к переформулировкам. Списки сливаются
 * по местам (RRF), потому что ts_rank и косинусное расстояние несравнимы.
 *
 * Векторы считает внешний API, и это делает гибрид не только вопросом
 * качества: когда провайдер недоступен, поиск обязан деградировать до
 * полнотекстового, а не отдавать пустой экран.
 */

/** Сколько заметок уходит в выдачу после слияния. */
const SEARCH_LIMIT = 20;

/** Длина сниппета под заголовком. */
const SNIPPET_CHARS = 200;

/**
 * fts — только слова, мгновенно и локально: этим режимом отвечаем на каждое
 * нажатие клавиши. hybrid — со смысловым слоем, дороже и с сетевым вызовом:
 * его клиент шлёт после паузы.
 */
export type SearchMode = "fts" | "hybrid";

/** Векторизатор. Параметром — чтобы тесты не ходили в сеть. */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface SearchHit {
  id: string;
  title: string;
  folderId: string | null;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * Участвовал ли смысловой слой. Отличает «нашлось только по словам»
   * от «смысловой поиск отработал и это всё» — и в режиме fts, и когда
   * внешний API отказал.
   */
  semantic: boolean;
}

export async function searchNotes(
  ownerId: string,
  rawQuery: string,
  options: { mode?: SearchMode; embed?: Embedder } = {},
): Promise<SearchResult> {
  const query = rawQuery.trim();
  if (!query) return { hits: [], semantic: false };

  // Полнотекстовый список считаем всегда и первым: он не зависит от сети,
  // и именно он останется ответом, если со смысловым слоем что-то не так.
  const lexical = await findLexicalMatches(ownerId, query);

  // Явно переданный векторизатор перебивает проверку переменных окружения:
  // так интеграционный тест включает гибрид без ключа MWS.
  const embed = options.embed ?? (isSemanticEnabled() ? embedTexts : null);

  if (options.mode !== "hybrid" || !embed) {
    return { hits: merge(lexical, []), semantic: false };
  }

  try {
    // Досчитываем отставшие векторы до поиска, иначе только что исправленная
    // заметка нашлась бы по старому тексту.
    await reindexStaleNotes(ownerId, embed);

    const [queryVector] = await embed([query]);
    const semantic = await findSemanticMatches(ownerId, queryVector);

    return { hits: merge(lexical, semantic), semantic: true };
  } catch (error) {
    // Не пробрасываем: 500 вместо рабочего полнотекстового поиска — худший
    // из возможных ответов. Пользователь увидит результаты, просто менее умные.
    console.error("Смысловой поиск недоступен, отдаём полнотекстовый:", error);

    return { hits: merge(lexical, []), semantic: false };
  }
}

/**
 * Заметки, близкие по смыслу к заданной.
 *
 * Дешевле поиска: векторы уже посчитаны, внешний API нужен только чтобы
 * догнать отставшие. Заметку, которую только что правили, догнать обязательно —
 * иначе похожие подбирались бы к предыдущей редакции текста.
 *
 * Владение проверяет сам запрос (пара id + owner_id в findRelatedNotes),
 * поэтому чужой noteId даёт пустой список, а не ошибку. Отдельно вычитывать
 * заметку ради проверки незачем: её content — до 512 КБ.
 */
export async function getRelatedNotes(
  ownerId: string,
  noteId: string,
  options: { embed?: Embedder } = {},
): Promise<SearchResult> {
  const embed = options.embed ?? (isSemanticEnabled() ? embedTexts : null);

  // Без векторов похожесть измерить нечем. Полнотекстового запасного слоя
  // здесь нет — «похожие по словам» это уже не похожие.
  if (!embed) return { hits: [], semantic: false };

  try {
    await reindexStaleNotes(ownerId, embed);
  } catch (error) {
    // Реиндексация — не повод остаться без блока: то, что уже посчитано,
    // покажем. Устаревшие векторы дадут менее точный, но живой список.
    console.error("Не удалось догнать векторы, ищем похожие по старым:", error);
  }

  const related = await findRelatedNotes(ownerId, noteId);

  return {
    hits: related.map((match) => ({
      id: match.id,
      title: match.title,
      folderId: match.folderId,
      snippet: markdownExcerpt(match.chunkText, SNIPPET_CHARS),
    })),
    semantic: true,
  };
}

/**
 * Доводит векторы заметок до текущего текста.
 *
 * Ленивая индексация вместо пересчёта при сохранении: редактор
 * автосохраняется постоянно, и каждая правка стоила бы вызова API.
 * Здесь же задержку и так прячет пауза перед запросом hybrid.
 */
async function reindexStaleNotes(
  ownerId: string,
  embed: Embedder,
): Promise<void> {
  const stale = await findStaleNotes(ownerId);
  if (stale.length === 0) return;

  const jobs = stale.map((note) => ({
    note,
    chunks: splitIntoChunks(note.content),
  }));

  // Все куски всех заметок уходят одним списком: разбиение на запросы —
  // забота embedTexts, здесь важно не делать по вызову на заметку.
  const vectors = await embed(
    jobs.flatMap(({ note, chunks }) =>
      chunks.map((chunk) => embeddingInput(note.title, chunk)),
    ),
  );

  let cursor = 0;

  for (const { note, chunks } of jobs) {
    const slice = vectors.slice(cursor, cursor + chunks.length);
    cursor += chunks.length;

    await replaceNoteChunks(
      note.id,
      note.sourceHash,
      chunks.map((text, index) => ({ text, embedding: slice[index] })),
    );
  }
}

/** Слияние двух списков в выдачу. */
function merge(
  lexical: LexicalMatch[],
  semantic: SemanticMatch[],
): SearchHit[] {
  const found = new Map<string, SearchHit>();

  for (const match of lexical) {
    found.set(match.id, {
      id: match.id,
      title: match.title,
      folderId: match.folderId,
      // preview — сырой markdown из начала заметки, его надо очистить.
      snippet: markdownExcerpt(match.preview, SNIPPET_CHARS),
    });
  }

  // Смысловое попадание знает, какой именно кусок совпал, — он информативнее
  // начала заметки, поэтому перекрывает сниппет от полнотекстового.
  for (const match of semantic) {
    found.set(match.id, {
      id: match.id,
      title: match.title,
      folderId: match.folderId,
      snippet: markdownExcerpt(match.chunkText, SNIPPET_CHARS),
    });
  }

  return fuseByRrf([
    lexical.map((match) => match.id),
    semantic.map((match) => match.id),
  ])
    .slice(0, SEARCH_LIMIT)
    .map(({ id }) => found.get(id))
    .filter((hit): hit is SearchHit => hit !== undefined);
}
