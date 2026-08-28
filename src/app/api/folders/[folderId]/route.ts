import { archiveFolder, renameFolder } from "@/domain/folders";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { parseBody, parseResourceId, updateFolderSchema } from "@/lib/validation";

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/folders/[folderId]">,
) {
  return authedJson(request, async (user) => {
    const { folderId } = await context.params;
    const id = parseResourceId(folderId);
    if (!id) throw notFound();

    const input = await parseBody(request, updateFolderSchema);
    if (input.title === undefined) {
      // Пустой PATCH — не ошибка, просто нечего менять.
      return { ok: true };
    }

    return renameFolder(user.id, id, input.title);
  });
}

export async function DELETE(
  request: Request,
  context: RouteContext<"/api/folders/[folderId]">,
) {
  return authedJson(request, async (user) => {
    const { folderId } = await context.params;
    const id = parseResourceId(folderId);
    if (!id) throw notFound();

    await archiveFolder(user.id, id);
    return { ok: true };
  });
}
