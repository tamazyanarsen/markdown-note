import { setNoteVisibility } from "@/domain/notes";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { parseResourceId } from "@/lib/validation";

export async function POST(
  request: Request,
  context: RouteContext<"/api/notes/[noteId]/publish">,
) {
  return authedJson(request, async (user) => {
    const { noteId } = await context.params;
    const id = parseResourceId(noteId);
    if (!id) throw notFound();

    return setNoteVisibility(user.id, id, "public");
  });
}
