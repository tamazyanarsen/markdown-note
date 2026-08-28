import { archiveNote, getOwnedNote, updateNote } from "@/domain/notes";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, parseResourceId, updateNoteSchema } from "@/lib/validation";

export async function GET(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]">,
) {
  return authedJson(
    request,
    async (user) => {
      const { noteId } = await context.params;
      const id = parseResourceId(noteId);
      if (!id) throw notFound();

      return getOwnedNote(user.id, id);
    },
    RATE_LIMITS.publicRead,
  );
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]">,
) {
  return authedJson(
    request,
    async (user) => {
      const { noteId } = await context.params;
      const id = parseResourceId(noteId);
      if (!id) throw notFound();

      const input = await parseBody(request, updateNoteSchema);
      if (input.title === undefined && input.content === undefined) {
        return { ok: true };
      }

      return updateNote(user.id, id, input);
    },
    // PATCH — это ещё и автосохранение редактора, оно идёт чаще мутаций.
    RATE_LIMITS.autosave,
  );
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]">,
) {
  return authedJson(request, async (user) => {
    const { noteId } = await context.params;
    const id = parseResourceId(noteId);
    if (!id) throw notFound();

    await archiveNote(user.id, id);
    return { ok: true };
  });
}
