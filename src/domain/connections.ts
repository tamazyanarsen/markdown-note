import { findBacklinks } from "@/db/queries/links";
import { markdownExcerpt } from "@/lib/markdown";

import { getRelatedNotes, type SearchHit } from "./search";

/**
 * Связи заметки: кто на неё ссылается и что на неё похоже.
 *
 * Два разных способа связать заметки, поэтому и списка два. Обратные ссылки
 * поставил человек — они точные и бесплатные. Похожие нашёл косинус — они
 * приблизительные и существуют только при включённом смысловом слое.
 * Смешивать их в один список нельзя: «ты сам это связал» и «возможно,
 * связано» — разные утверждения.
 *
 * Собраны вместе ради одного запроса от клиента вместо двух: панель под
 * редактором показывает оба списка сразу.
 */

/** Длина сниппета под заголовком — та же, что в выдаче поиска. */
const SNIPPET_CHARS = 200;

export interface NoteConnections {
  /** Заметки, ссылающиеся на эту. */
  backlinks: SearchHit[];
  /** Близкие по смыслу. Пусто, когда смысловой слой выключен. */
  related: SearchHit[];
  /** Участвовал ли смысловой слой — отличает «нет похожих» от «не искали». */
  semantic: boolean;
}

export async function getNoteConnections(
  ownerId: string,
  noteId: string,
): Promise<NoteConnections> {
  // Параллельно: бэклинки — обычный индексный запрос, похожие могут ждать
  // внешний API на реиндексации. Последовательно панель ждала бы обоих.
  const [backlinks, related] = await Promise.all([
    findBacklinks(ownerId, noteId),
    getRelatedNotes(ownerId, noteId),
  ]);

  return {
    backlinks: backlinks.map((note) => ({
      id: note.id,
      title: note.title,
      folderId: note.folderId,
      // preview — сырой markdown из начала заметки, его надо очистить.
      snippet: markdownExcerpt(note.preview, SNIPPET_CHARS),
    })),
    related: related.hits,
    semantic: related.semantic,
  };
}
