import { purgeFolder, purgeNote } from "@/domain/trash";
import { authedJson } from "@/lib/api";
import { parseTrashParams } from "@/lib/trash-params";

/** Удаление из корзины насовсем: DELETE /api/trash/{notes|folders}/:id. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/trash/[kind]/[id]">,
) {
  return authedJson(request, async (user) => {
    const params = await context.params;
    const { kind, id } = parseTrashParams(params.kind, params.id);

    if (kind === "notes") await purgeNote(user.id, id);
    else await purgeFolder(user.id, id);

    return { ok: true };
  });
}
