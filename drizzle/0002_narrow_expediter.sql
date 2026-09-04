-- Дописано вручную: drizzle-kit не генерирует расширения, а тип vector
-- без него не существует. Образ pgvector/pgvector:pg17 несёт само расширение,
-- но включать его в конкретной базе всё равно надо явно.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "note_chunks" (
	"note_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"source_hash" text NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	CONSTRAINT "note_chunks_note_id_chunk_index_pk" PRIMARY KEY("note_id","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "note_chunks" ADD CONSTRAINT "note_chunks_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;