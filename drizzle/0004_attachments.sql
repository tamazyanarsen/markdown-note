CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_owner_idx" ON "attachments" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "attachments_note_idx" ON "attachments" USING btree ("note_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Инвариант вложений: файл может принадлежать только заметке того же
-- владельца. Без него владелец вложения и владелец заметки разошлись бы,
-- а доступ к файлу определяется именно заметкой — то есть чужой файл
-- оказался бы виден по чужой публикации.
--
-- Дописано вручную: drizzle-kit триггеры не выводит из схемы. Стиль тот же,
-- что у ensure_note_folder_owner_matches в первой миграции.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_attachment_note_owner_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_note_owner_id uuid;
BEGIN
  SELECT owner_id
  INTO target_note_owner_id
  FROM notes
  WHERE id = new.note_id
    AND is_archived = false;

  IF target_note_owner_id IS NULL THEN
    RAISE EXCEPTION 'Target note does not exist or is archived';
  END IF;

  IF new.owner_id <> target_note_owner_id THEN
    RAISE EXCEPTION 'An attachment can only belong to a note of the same owner';
  END IF;

  RETURN new;
END;
$$;--> statement-breakpoint

CREATE TRIGGER attachments_owner_matches_note_owner
BEFORE INSERT OR UPDATE OF note_id, owner_id
ON attachments
FOR EACH ROW
EXECUTE FUNCTION ensure_attachment_note_owner_matches();