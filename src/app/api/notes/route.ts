import { createNote } from "@/domain/notes";
import { authedJson } from "@/lib/api";
import { createNoteSchema, parseBody } from "@/lib/validation";

export async function POST(request: Request) {
  return authedJson(request, async (user) => {
    const input = await parseBody(request, createNoteSchema);
    return createNote(user.id, input);
  });
}
