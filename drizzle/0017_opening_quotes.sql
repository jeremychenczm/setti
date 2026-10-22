CREATE TABLE "opening_quotes" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"sent_by" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_quotes_first_version" CHECK ("opening_quotes"."version" = 1),
	CONSTRAINT "opening_quotes_hash_format" CHECK ("opening_quotes"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "opening_quotes" ADD CONSTRAINT "opening_quotes_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_quotes" ADD CONSTRAINT "opening_quotes_message_fk" FOREIGN KEY ("case_id","message_id") REFERENCES "public"."chat_messages"("case_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Opening quote rules enforced by the database:
--   1. The quote card is a designer's message in the same demo case, and the frozen
--      document belongs to that case's project.
--   2. A sent V1 is a record: never changed or deleted.
CREATE OR REPLACE FUNCTION opening_quotes_match_case() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chat_messages WHERE case_id = NEW.case_id AND id = NEW.message_id AND actor = 'designer') THEN
    RAISE EXCEPTION 'an opening quote is sent by the designer in its own demo case' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.document ->> 'projectId' IS DISTINCT FROM (SELECT project_key FROM chat_cases WHERE id = NEW.case_id)
     OR (NEW.document ->> 'version')::integer IS DISTINCT FROM NEW.version THEN
    RAISE EXCEPTION 'the opening quote document does not belong to this project and version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER opening_quotes_match_case
  BEFORE INSERT ON opening_quotes
  FOR EACH ROW EXECUTE FUNCTION opening_quotes_match_case();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION opening_quotes_frozen() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a sent quote is frozen and cannot be changed or deleted' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER opening_quotes_frozen
  BEFORE UPDATE OR DELETE ON opening_quotes
  FOR EACH ROW EXECUTE FUNCTION opening_quotes_frozen();
