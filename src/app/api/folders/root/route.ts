import { loadOwnerTree } from "@/db/queries/tree";
import { authedJson } from "@/lib/api";
import { RATE_LIMITS } from "@/lib/rate-limit";

/** Полное личное дерево пользователя. */
export async function GET(request: Request) {
  return authedJson(
    request,
    async (user) => ({ children: await loadOwnerTree(user.id) }),
    RATE_LIMITS.publicRead,
  );
}
