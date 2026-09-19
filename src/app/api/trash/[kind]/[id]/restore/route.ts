import { restoreFolder, restoreNote } from "@/domain/trash";
import { authedJson } from "@/lib/api";
import { parseTrashParams } from "@/lib/trash-params";

/** Восстановление: POST /api/trash/{notes|folders}/:id/restore. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/trash/[kind]/[id]/restore">,
) {
  return authedJson(request, async (user) => {
    const params = await context.params;
    const { kind, id } = parseTrashParams(params.kind, params.id);

    return kind === "notes"
      ? restoreNote(user.id, id)
      : restoreFolder(user.id, id);
  });
}
