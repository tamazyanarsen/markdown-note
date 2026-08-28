-- citext нужен для users.email: сравнение без учёта регистра.
-- gen_random_uuid() входит в ядро начиная с PostgreSQL 13, pgcrypto не требуется.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."note_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"position" numeric(20, 10) DEFAULT '1000' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_cannot_be_own_parent" CHECK ("folders"."id" <> "folders"."parent_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"visibility" "note_visibility" DEFAULT 'private' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"position" numeric(20, 10) DEFAULT '1000' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('russian', coalesce("notes"."title", '') || ' ' || coalesce("notes"."content", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"email" "citext",
	"email_verified" timestamp with time zone,
	"image" text,
	"is_approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folders_parent_position_idx" ON "folders" USING btree ("parent_id","position") WHERE "folders"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "folders_owner_parent_position_idx" ON "folders" USING btree ("owner_id","parent_id","position") WHERE "folders"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "notes_folder_position_idx" ON "notes" USING btree ("folder_id","position") WHERE "notes"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "notes_public_folder_position_idx" ON "notes" USING btree ("folder_id","position") WHERE "notes"."visibility" = 'public' and "notes"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "notes_owner_idx" ON "notes" USING btree ("owner_id") WHERE "notes"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email") WHERE "users"."email" is not null;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Инвариант дерева: ресурс может лежать только в папке того же владельца.
--
-- Основная проверка живёт в src/domain/, но она защищает только путь через
-- приложение. Триггер закрывает прямой SQL, будущие миграции и любой второй
-- сервис, который однажды получит доступ к этой базе.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_note_folder_owner_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_folder_owner_id uuid;
BEGIN
  IF new.folder_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT owner_id
  INTO target_folder_owner_id
  FROM folders
  WHERE id = new.folder_id
    AND is_archived = false;

  IF target_folder_owner_id IS NULL THEN
    RAISE EXCEPTION 'Target folder does not exist or is archived';
  END IF;

  IF new.owner_id <> target_folder_owner_id THEN
    RAISE EXCEPTION 'A note can only be placed in a folder of the same owner';
  END IF;

  RETURN new;
END;
$$;--> statement-breakpoint

CREATE TRIGGER notes_owner_matches_folder_owner
BEFORE INSERT OR UPDATE OF folder_id, owner_id
ON notes
FOR EACH ROW
EXECUTE FUNCTION ensure_note_folder_owner_matches();--> statement-breakpoint

CREATE OR REPLACE FUNCTION ensure_folder_parent_owner_matches()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_parent_owner_id uuid;
BEGIN
  IF new.parent_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT owner_id
  INTO target_parent_owner_id
  FROM folders
  WHERE id = new.parent_id
    AND is_archived = false;

  IF target_parent_owner_id IS NULL THEN
    RAISE EXCEPTION 'Target parent folder does not exist or is archived';
  END IF;

  IF new.owner_id <> target_parent_owner_id THEN
    RAISE EXCEPTION 'A folder can only be placed in a folder of the same owner';
  END IF;

  RETURN new;
END;
$$;--> statement-breakpoint

CREATE TRIGGER folders_owner_matches_parent_owner
BEFORE INSERT OR UPDATE OF parent_id, owner_id
ON folders
FOR EACH ROW
EXECUTE FUNCTION ensure_folder_parent_owner_matches();