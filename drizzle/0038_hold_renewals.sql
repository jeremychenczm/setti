ALTER TABLE "hold_checks" ADD COLUMN "renewals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "replaces_authorization_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "renewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "renewal_notices" ADD COLUMN "noticed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_replaces_authorization_id_paypal_authorizations_id_fk" FOREIGN KEY ("replaces_authorization_id") REFERENCES "public"."paypal_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_operations_one_renewal" ON "payment_operations" USING btree ("replaces_authorization_id") WHERE "payment_operations"."replaces_authorization_id" IS NOT NULL AND "payment_operations"."status" <> 'failed';--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_renewal_is_saved_hold" CHECK ("payment_operations"."replaces_authorization_id" IS NULL OR ("payment_operations"."kind" = 'authorize' AND "payment_operations"."saved_method_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_renewal_clock" CHECK (("payment_operations"."replaces_authorization_id" IS NULL) = ("payment_operations"."renewed_at" IS NULL));--> statement-breakpoint
-- Hold renewal rules enforced by the database:
--   1. A renewal replaces an open hold of the same project and the same item, from which nothing was captured.
--   2. Which hold a renewal replaces, and the clock it ran against, never change.
--   3. On a signed V1, a hold that a succeeded renewal replaced may be voided.
--   4. A renewal notice is a record, with the clock it was given at.
CREATE OR REPLACE FUNCTION payment_operations_renewal_guard() RETURNS trigger AS $$
DECLARE
  old_hold paypal_authorizations%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.replaces_authorization_id IS DISTINCT FROM OLD.replaces_authorization_id OR NEW.renewed_at IS DISTINCT FROM OLD.renewed_at THEN
      RAISE EXCEPTION 'which hold a renewal replaces, and when, cannot change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.replaces_authorization_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- A repeated business event is answered by the unique business key.
  IF EXISTS (SELECT 1 FROM payment_operations WHERE business_key = NEW.business_key) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO old_hold FROM paypal_authorizations WHERE id = NEW.replaces_authorization_id FOR SHARE;
  IF old_hold.project_id IS DISTINCT FROM NEW.project_id OR old_hold.item_id IS DISTINCT FROM NEW.item_id THEN
    RAISE EXCEPTION 'a renewal replaces a hold of the same project and item' USING ERRCODE = 'check_violation';
  END IF;
  IF old_hold.status NOT IN ('created', 'partially_captured')
     OR EXISTS (SELECT 1 FROM paypal_captures WHERE authorization_id = old_hold.id AND status <> 'declined') THEN
    RAISE EXCEPTION 'only an open hold nothing was captured from can be renewed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_renewal_guard
  BEFORE INSERT OR UPDATE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_renewal_guard();
--> statement-breakpoint
DROP TRIGGER renewal_notices_immutable ON renewal_notices;
--> statement-breakpoint
CREATE TRIGGER renewal_notices_immutable
  BEFORE UPDATE OR DELETE ON renewal_notices
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('authorization_id', 'case_id', 'message_id', 'noticed_at', 'created_at');
--> statement-breakpoint
-- As in 0035, plus: on V1, a hold that a succeeded renewal replaced may be voided.
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
  -- The design-services hold names no item; its split is checked line by line.
  IF NOT (NEW.services_hold AND NEW.item_id IS NULL) AND NOT EXISTS (
    SELECT 1 FROM approvals a JOIN revision_lines l ON l.id = a.revision_line_id
    WHERE a.revision_id = rev.id AND l.item_id = NEW.item_id AND a.decision = 'approved' AND a.content_hash = rev.content_hash
  ) THEN
    RAISE EXCEPTION 'the client has not approved this line of quote V1' USING ERRCODE = 'check_violation';
  END IF;
  -- On V1, money moves are holds, the design services captured from their hold, items
  -- captured after the supplier confirmed them on V1, the holds of an item the studio
  -- cancelled, and a hold a renewal replaced.
  IF NEW.kind <> 'authorize' AND NOT (NEW.kind = 'capture' AND (NEW.supplier_event_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM paypal_authorizations a JOIN payment_operations o ON o.id = a.operation_id WHERE a.id = NEW.authorization_id AND o.services_hold
  ))) AND NOT (NEW.kind = 'void' AND EXISTS (SELECT 1 FROM paypal_authorizations a WHERE a.id = NEW.authorization_id AND a.item_id = NEW.item_id)
    AND (EXISTS (SELECT 1 FROM item_cancellations c WHERE c.item_id = NEW.item_id)
      OR EXISTS (SELECT 1 FROM payment_operations r WHERE r.replaces_authorization_id = NEW.authorization_id AND r.status = 'succeeded'))) THEN
    RAISE EXCEPTION 'a % cannot be bound to quote V1 yet', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
