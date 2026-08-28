import { createFolder } from "@/domain/folders";
import { authedJson } from "@/lib/api";
import { createFolderSchema, parseBody } from "@/lib/validation";

export async function POST(request: Request) {
  return authedJson(request, async (user) => {
    const input = await parseBody(request, createFolderSchema);
    return createFolder(user.id, input);
  });
}
