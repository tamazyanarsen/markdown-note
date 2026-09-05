"use client";

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { toast } from "sonner";

import type { UploadedAttachment } from "@/domain/attachments";
import { ApiError, apiFetch } from "@/lib/api-client";

/**
 * Загрузка файлов прямо в редактор: вставкой из буфера и перетаскиванием.
 *
 * Пока файл летит на сервер, в тексте стоит плейсхолдер с уникальным
 * маркером, и по завершении он заменяется настоящей ссылкой. Вставлять
 * ссылку только в конце нельзя: за секунды загрузки курсор уедет, и картинка
 * встанет посреди слова, которое человек в это время набирал.
 *
 * Правки идут транзакцией CodeMirror, а не через React-состояние: value
 * у редактора контролируемый, и запись в состояние в обход view дала бы
 * два источника правды и прыгающий курсор.
 */

/** Текст ссылки в плейсхолдере: скобки закрыли бы его раньше времени. */
function safeName(name: string): string {
  return name.replace(/[[\]]/g, "").slice(0, 80) || "файл";
}

function filesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  return [...transfer.files];
}

/**
 * Заменяет первое вхождение плейсхолдера на готовую разметку.
 *
 * Позицию ищем в тексте заново, а не запоминаем: пока файл грузился, выше
 * могли дописать абзац, и сохранённое смещение указывало бы не туда.
 */
function replacePlaceholder(
  view: EditorView,
  placeholder: string,
  replacement: string,
): void {
  const at = view.state.doc.toString().indexOf(placeholder);
  if (at < 0) return;

  view.dispatch({
    changes: { from: at, to: at + placeholder.length, insert: replacement },
  });
}

async function uploadOne(
  view: EditorView,
  noteId: string,
  file: File,
  at: number,
): Promise<void> {
  const name = safeName(file.name);
  // Маркер уникален, поэтому две одновременные загрузки не перепутают
  // свои плейсхолдеры между собой.
  const placeholder = `![${name} — загружаю…](upload:${crypto.randomUUID()})`;

  view.dispatch({
    changes: { from: at, to: at, insert: placeholder },
  });

  const form = new FormData();
  form.append("file", file);

  try {
    const uploaded = await apiFetch<UploadedAttachment>(
      `/api/notes/${noteId}/attachments`,
      { method: "POST", body: form },
    );

    // Картинка встаёт как ![…](), остальное — обычной ссылкой: pdf,
    // вставленный через «!», показался бы сломанной картинкой.
    const prefix = uploaded.inline ? "!" : "";
    replacePlaceholder(
      view,
      placeholder,
      `${prefix}[${uploaded.filename}](${uploaded.url})`,
    );
  } catch (cause) {
    // Плейсхолдер убираем: оставить в тексте «загружаю…» навсегда хуже,
    // чем не вставить ничего.
    replacePlaceholder(view, placeholder, "");

    toast.error(
      cause instanceof ApiError ? cause.message : "Не удалось загрузить файл.",
    );
  }
}

/**
 * Файлы грузятся по очереди, а не разом: каждая вставка сдвигает текст,
 * и параллельные транзакции считали бы позиции по устаревшему документу.
 */
async function uploadAll(
  view: EditorView,
  noteId: string,
  files: File[],
  at: number,
): Promise<void> {
  for (const file of files) {
    // Позиция берётся заново перед каждым файлом: предыдущий уже вставил
    // свой плейсхолдер и сдвинул всё, что после него.
    await uploadOne(view, noteId, file, Math.min(at, view.state.doc.length));
    at = view.state.selection.main.head;
  }
}

/**
 * Расширение редактора: перехват вставки и перетаскивания файлов.
 *
 * Возвращаем false, когда файлов нет, — тогда CodeMirror обработает событие
 * сам, и обычная вставка текста продолжает работать как раньше.
 */
export function attachmentUpload(noteId: string): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = filesFrom(event.clipboardData);
      if (files.length === 0) return false;

      event.preventDefault();
      void uploadAll(view, noteId, files, view.state.selection.main.head);
      return true;
    },

    drop(event, view) {
      const files = filesFrom(event.dataTransfer);
      if (files.length === 0) return false;

      event.preventDefault();

      // Файл кладётся туда, куда его бросили, а не туда, где остался курсор.
      const dropped = view.posAtCoords({ x: event.clientX, y: event.clientY });
      void uploadAll(
        view,
        noteId,
        files,
        dropped ?? view.state.selection.main.head,
      );
      return true;
    },
  });
}
