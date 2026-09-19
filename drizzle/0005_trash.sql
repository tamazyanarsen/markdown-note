ALTER TABLE "folders" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "folders_owner_archived_idx" ON "folders" USING btree ("owner_id","archived_at") WHERE "folders"."is_archived" = true;--> statement-breakpoint
CREATE INDEX "notes_owner_archived_idx" ON "notes" USING btree ("owner_id","archived_at") WHERE "notes"."is_archived" = true;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill: всё, что уже архивировано, считаем удалённым в момент последней
-- правки. archiveNote и archiveFolder всегда обновляли updated_at вместе
-- с is_archived, а других правок у архивной строки быть не могло: каждый
-- update ищет ресурс с условием is_archived = false.
--
-- Обязан идти ДО check-констрейнта ниже: тот запрещает архивную строку
-- с пустым archived_at, и на непустой базе без backfill не применился бы.
--
-- Дописано вручную: drizzle-kit такие шаги не выводит из схемы. Тот же
-- приём, что у триггеров в 0000 и 0004.
-- ---------------------------------------------------------------------------

UPDATE "notes" SET "archived_at" = "updated_at" WHERE "is_archived" AND "archived_at" IS NULL;--> statement-breakpoint
UPDATE "folders" SET "archived_at" = "updated_at" WHERE "is_archived" AND "archived_at" IS NULL;--> statement-breakpoint

ALTER TABLE "folders" ADD CONSTRAINT "folders_archived_at_matches_flag" CHECK ("folders"."is_archived" = ("folders"."archived_at" is not null));--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_archived_at_matches_flag" CHECK ("notes"."is_archived" = ("notes"."archived_at" is not null));
