import { emptyTrash, listTrash } from "@/domain/trash";
import { authedJson } from "@/lib/api";
import { RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(request: Request) {
  return authedJson(request, (user) => listTrash(user.id), RATE_LIMITS.publicRead);
}

export async function DELETE(request: Request) {
  return authedJson(request, async (user) => {
    await emptyTrash(user.id);
    return { ok: true };
  });
}
