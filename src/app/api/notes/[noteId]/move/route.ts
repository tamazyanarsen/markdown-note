import { moveNote } from "@/domain/move";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { moveSchema, parseBody, parseResourceId } from "@/lib/validation";

export async function POST(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]/move">,
) {
  return authedJson(request, async (user) => {
    const { noteId } = await context.params;
    const id = parseResourceId(noteId);
    if (!id) throw notFound();

    const input = await parseBody(request, moveSchema);
    return moveNote(user.id, id, input);
  });
}
