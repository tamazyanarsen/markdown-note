import { moveFolder } from "@/domain/move";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { moveSchema, parseBody, parseResourceId } from "@/lib/validation";

export async function POST(
  request: Request,
  context: RouteContext<"/api/folders/[folderId]/move">,
) {
  return authedJson(request, async (user) => {
    const { folderId } = await context.params;
    const id = parseResourceId(folderId);
    if (!id) throw notFound();

    const input = await parseBody(request, moveSchema);
    return moveFolder(user.id, id, input);
  });
}
