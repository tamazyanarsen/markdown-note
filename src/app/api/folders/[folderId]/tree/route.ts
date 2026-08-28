import { findSubtree, loadOwnerTree } from "@/db/queries/tree";
import { getOwnedFolder } from "@/domain/folders";
import { authedJson } from "@/lib/api";
import { notFound } from "@/lib/errors";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { parseResourceId } from "@/lib/validation";

/** Поддерево владельца целиком: и public-, и private-заметки. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/folders/[folderId]/tree">,
) {
  return authedJson(
    request,
    async (user) => {
      const { folderId } = await context.params;
      const id = parseResourceId(folderId);
      if (!id) throw notFound();

      // Явная проверка владения: без неё чужой folderId просто не нашёлся бы
      // в дереве и вернул бы 404 — тот же ответ, но по случайной причине.
      await getOwnedFolder(user.id, id);

      const subtree = findSubtree(await loadOwnerTree(user.id), id);
      if (!subtree) throw notFound();

      return subtree;
    },
    RATE_LIMITS.publicRead,
  );
}
