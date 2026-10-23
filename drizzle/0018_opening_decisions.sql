CREATE TABLE "opening_withdrawals" (
	"case_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"withdrawn_by" text NOT NULL,
	"withdrawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_withdrawals_case_id_item_id_pk" PRIMARY KEY("case_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "signing_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "about_item_id" text;--> statement-breakpoint
ALTER TABLE "opening_withdrawals" ADD CONSTRAINT "opening_withdrawals_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_signed_decline_has_reason" CHECK ("approvals"."signing_id" IS NULL OR "approvals"."decision" <> 'declined' OR length(btrim(coalesce("approvals"."note", ''))) > 0);--> statement-breakpoint
-- Opening decision rules enforced by the database:
--   1. A dropped line and a message's line tag name a line of the case's sent V1.
--   2. A dropped line is a record: never changed or deleted.
CREATE OR REPLACE FUNCTION opening_line_exists(case_uuid uuid, line_item text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM opening_quotes q, jsonb_array_elements(q.document -> 'lines') AS line
    WHERE q.case_id = case_uuid AND line ->> 'itemId' = line_item
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION opening_withdrawals_match_case() RETURNS trigger AS $$
BEGIN
  IF NOT opening_line_exists(NEW.case_id, NEW.item_id) THEN
    RAISE EXCEPTION 'only a line of this case''s sent V1 can be dropped' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER opening_withdrawals_match_case
  BEFORE INSERT ON opening_withdrawals
  FOR EACH ROW EXECUTE FUNCTION opening_withdrawals_match_case();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION opening_withdrawals_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a dropped line is a record and cannot be changed or deleted' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER opening_withdrawals_append_only
  BEFORE UPDATE OR DELETE ON opening_withdrawals
  FOR EACH ROW EXECUTE FUNCTION opening_withdrawals_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION chat_messages_line_tag_matches() RETURNS trigger AS $$
BEGIN
  IF NEW.about_item_id IS NOT NULL AND NOT opening_line_exists(NEW.case_id, NEW.about_item_id) THEN
    RAISE EXCEPTION 'a message can only be tagged with a line of this case''s sent V1' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER chat_messages_line_tag_matches
  BEFORE INSERT OR UPDATE OF about_item_id ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat_messages_line_tag_matches();
