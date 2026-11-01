CREATE TABLE "item_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"change_order_id" uuid,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"cancelled_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_cancellations_item_id_unique" UNIQUE("item_id"),
	CONSTRAINT "item_cancellations_reason" CHECK ("item_cancellations"."reason" IN ('unavailable', 'no_response', 'client_asked', 'other')),
	CONSTRAINT "item_cancellations_note" CHECK (length("item_cancellations"."note") <= 1000 AND ("item_cancellations"."reason" <> 'other' OR length(btrim("item_cancellations"."note")) > 0)),
	CONSTRAINT "item_cancellations_by" CHECK (length(btrim("item_cancellations"."cancelled_by")) > 0)
);
--> statement-breakpoint
ALTER TABLE "item_cancellations" ADD CONSTRAINT "item_cancellations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_cancellations" ADD CONSTRAINT "item_cancellations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_cancellations" ADD CONSTRAINT "item_cancellations_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_cancellations" ADD CONSTRAINT "item_cancellations_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Item cancellation rules enforced by the database:
--   1. A cancellation names a furniture item of its own project, and the version in force when it was made.
--   2. Only an item with nothing charged can be cancelled: no capture, completed or pending, on it or its holds.
--   3. An item whose PayPal step is still open (pending or unknown) cannot be cancelled until that step is settled.
--   4. A cancelled item is never held or captured again. Its open holds may be voided, also on a signed V1.
--   5. A cancellation is a record: never changed or deleted.
CREATE OR REPLACE FUNCTION item_cancellations_guard() RETURNS trigger AS $$
BEGIN
  -- Serialises a cancellation with the item's other money steps.
  PERFORM 1 FROM items WHERE id = NEW.item_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = NEW.project_id AND kind = 'furniture') THEN
    RAISE EXCEPTION 'only a furniture item of this project can be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM revisions WHERE id = NEW.revision_id AND project_id = NEW.project_id)
     OR (NEW.change_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM change_orders WHERE id = NEW.change_order_id AND revision_id = NEW.revision_id)) THEN
    RAISE EXCEPTION 'a cancellation names a version of its own project' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM paypal_captures c LEFT JOIN paypal_authorizations a ON a.id = c.authorization_id
    WHERE c.status <> 'declined' AND (c.item_id = NEW.item_id OR a.item_id = NEW.item_id)
  ) THEN
    RAISE EXCEPTION 'this item was already charged; it can no longer be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_operations WHERE item_id = NEW.item_id AND status IN ('pending', 'unknown')) THEN
    RAISE EXCEPTION 'a PayPal step for this item is still open; settle it before cancelling' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER item_cancellations_guard
  BEFORE INSERT ON item_cancellations
  FOR EACH ROW EXECUTE FUNCTION item_cancellations_guard();
--> statement-breakpoint
CREATE TRIGGER item_cancellations_immutable
  BEFORE UPDATE OR DELETE ON item_cancellations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'item_id', 'revision_id', 'change_order_id', 'reason', 'note', 'cancelled_by', 'created_at');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_cancelled_item_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.item_id IS NULL OR NEW.kind NOT IN ('authorize', 'capture', 'reauthorize') THEN
    RETURN NEW;
  END IF;
  -- A repeated business event is answered by the unique business key.
  IF EXISTS (SELECT 1 FROM payment_operations WHERE business_key = NEW.business_key) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM items WHERE id = NEW.item_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM item_cancellations WHERE item_id = NEW.item_id) THEN
    RAISE EXCEPTION 'the studio cancelled this item; it is not held or charged again' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_cancelled_item_guard
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_cancelled_item_guard();
--> statement-breakpoint
-- As in 0026, plus: on V1, a cancelled item's own holds may be voided.
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
  -- captured after the supplier confirmed them on V1, and the holds of an item the studio cancelled.
  IF NEW.kind <> 'authorize' AND NOT (NEW.kind = 'capture' AND (NEW.supplier_event_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM paypal_authorizations a JOIN payment_operations o ON o.id = a.operation_id WHERE a.id = NEW.authorization_id AND o.services_hold
  ))) AND NOT (NEW.kind = 'void' AND EXISTS (SELECT 1 FROM item_cancellations c WHERE c.item_id = NEW.item_id)
    AND EXISTS (SELECT 1 FROM paypal_authorizations a WHERE a.id = NEW.authorization_id AND a.item_id = NEW.item_id)) THEN
    RAISE EXCEPTION 'a % cannot be bound to quote V1 yet', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
