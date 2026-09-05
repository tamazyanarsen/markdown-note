CREATE TABLE "note_links" (
	"source_note_id" uuid NOT NULL,
	"target_note_id" uuid NOT NULL,
	CONSTRAINT "note_links_source_note_id_target_note_id_pk" PRIMARY KEY("source_note_id","target_note_id"),
	CONSTRAINT "note_links_no_self_link" CHECK ("note_links"."source_note_id" <> "note_links"."target_note_id")
);
--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_source_note_id_notes_id_fk" FOREIGN KEY ("source_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_links" ADD CONSTRAINT "note_links_target_note_id_notes_id_fk" FOREIGN KEY ("target_note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_links_target_idx" ON "note_links" USING btree ("target_note_id");--> statement-breakpoint
-- Дописано вручную: разовый бэкфил уже существующих заметок.
--
-- Без него обратные ссылки появились бы только у тех заметок, которые после
-- миграции кто-то откроет и сохранит — то есть выглядели бы сломанными.
--
-- Регулярка здесь грубее разбора AST в src/lib/links.ts: она не отличает
-- ссылку от примера внутри ```-блока. Это осознанно — один лишний бэклинк
-- дешевле, чем отсутствие всех, а первое же сохранение заметки перепишет
-- её связи точно.
INSERT INTO "note_links" ("source_note_id", "target_note_id")
SELECT DISTINCT src.id, tgt.id
FROM "notes" src
CROSS JOIN LATERAL regexp_matches(
  src.content,
  '\]\((?:https?://[^/)]+)?/n/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[^)]*\)',
  'g'
) AS m
JOIN "notes" tgt ON tgt.id = m[1]::uuid
WHERE tgt.owner_id = src.owner_id
  AND src.is_archived = false
  AND tgt.is_archived = false
  AND tgt.id <> src.id
ON CONFLICT DO NOTHING;