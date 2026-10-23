ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_authorize_is_bound";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_binding_complete";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_authorize_is_bound" CHECK ("payment_operations"."kind" <> 'authorize' OR "payment_operations"."revision_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_binding_complete" CHECK (("payment_operations"."change_order_id" IS NULL AND "payment_operations"."revision_id" IS NULL AND "payment_operations"."content_hash" IS NULL AND "payment_operations"."revision_content_hash" IS NULL) OR ("payment_operations"."revision_id" IS NOT NULL AND "payment_operations"."content_hash" IS NOT NULL AND "payment_operations"."revision_content_hash" IS NOT NULL AND "payment_operations"."item_id" IS NOT NULL));--> statement-breakpoint
-- A V1 signed line by line has no change order. Rules for a payment move bound to it:
--   1. It names the case's open V1: the revision is still sent (no newer version replaced it),
--      both hashes are the ones the client signed, and it is this project's V1.
--   2. Its item is a line the client approved on that V1; declined and undecided lines are not agreed.
--   3. For now it can only place a hold; capturing, releasing and refunding follow later steps.
CREATE OR REPLACE FUNCTION payment_operations_opening_guard() RETURNS trigger AS $$
DECLARE
  rev revisions%ROWTYPE;
  opening_case uuid;
  opening_hash text;
BEGIN
  IF NEW.change_order_id IS NOT NULL OR NEW.revision_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A repeated business event is answered by the unique business key.
  IF EXISTS (SELECT 1 FROM payment_operations WHERE business_key = NEW.business_key) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO rev FROM revisions WHERE id = NEW.revision_id FOR SHARE;
  SELECT case_id INTO opening_case FROM pricing_cases WHERE baseline_revision_id = rev.id AND project_id = NEW.project_id;
  SELECT content_hash INTO opening_hash FROM opening_quotes WHERE case_id = opening_case;
  IF opening_hash IS NULL OR rev.project_id IS DISTINCT FROM NEW.project_id
     OR rev.content_hash IS DISTINCT FROM NEW.revision_content_hash OR opening_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'payment operation does not match the signed quote V1 it names' USING ERRCODE = 'check_violation';
  END IF;
  IF rev.status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'quote V1 is %; payments start from the version that replaced it', rev.status USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM approvals a JOIN revision_lines l ON l.id = a.revision_line_id
    WHERE a.revision_id = rev.id AND l.item_id = NEW.item_id AND a.decision = 'approved' AND a.content_hash = rev.content_hash
  ) THEN
    RAISE EXCEPTION 'the client has not approved this line of quote V1' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> 'authorize' THEN
    RAISE EXCEPTION 'a % cannot be bound to quote V1 yet', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_opening_guard
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_opening_guard();
