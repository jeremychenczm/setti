CREATE TABLE "services_hold_lines" (
	"operation_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "services_hold_lines_operation_id_item_id_pk" PRIMARY KEY("operation_id","item_id"),
	CONSTRAINT "services_hold_lines_amount" CHECK ("services_hold_lines"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_capture_after_supplier";--> statement-breakpoint
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_binding_complete";--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "services_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "services_hold_lines" ADD CONSTRAINT "services_hold_lines_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services_hold_lines" ADD CONSTRAINT "services_hold_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_services_hold" CHECK (NOT "payment_operations"."services_hold" OR ("payment_operations"."kind" = 'authorize' AND "payment_operations"."item_id" IS NULL AND "payment_operations"."saved_method_id" IS NULL AND "payment_operations"."revision_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_binding_complete" CHECK (("payment_operations"."change_order_id" IS NULL AND "payment_operations"."revision_id" IS NULL AND "payment_operations"."content_hash" IS NULL AND "payment_operations"."revision_content_hash" IS NULL) OR ("payment_operations"."revision_id" IS NOT NULL AND "payment_operations"."content_hash" IS NOT NULL AND "payment_operations"."revision_content_hash" IS NOT NULL AND ("payment_operations"."item_id" IS NOT NULL OR "payment_operations"."services_hold")));--> statement-breakpoint
-- Design services rules enforced by the database:
--   1. A design-services hold is split across approved service lines of the version it is
--      bound to, each at most that line's total, together at most the hold; the hold is
--      recorded only when the split adds up to exactly its amount. The split never changes.
--   2. A project has at most one unresolved design-services hold.
--   3. A capture from the design-services hold pays one service of its split, up to what is
--      left of that service's share, under the same version as the hold. It needs no supplier
--      confirmation; every other capture of a client-confirmed version still does.
--   4. A capture from the design-services hold records which service it paid for.
-- The operation guard below is the one from the execution guards, now letting a capture
-- name an item when its hold (the design-services hold) has none.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_guard() RETURNS trigger AS $$
DECLARE
  doc change_orders%ROWTYPE;
  rev revisions%ROWTYPE;
  case_project uuid;
  auth paypal_authorizations%ROWTYPE;
  cap paypal_captures%ROWTYPE;
  cap_item uuid;
  used bigint;
BEGIN
  IF NEW.authorization_id IS NOT NULL THEN
    SELECT * INTO auth FROM paypal_authorizations WHERE id = NEW.authorization_id FOR UPDATE;
  END IF;
  IF NEW.capture_id IS NOT NULL THEN
    SELECT * INTO cap FROM paypal_captures WHERE id = NEW.capture_id FOR UPDATE;
  END IF;
  IF NEW.kind = 'authorize' THEN
    PERFORM 1 FROM items WHERE id = NEW.item_id FOR UPDATE;
  END IF;
  -- A repeated business event is answered by the unique business key, not by the checks below.
  IF EXISTS (SELECT 1 FROM payment_operations WHERE business_key = NEW.business_key) THEN
    RETURN NEW;
  END IF;

  IF NEW.change_order_id IS NOT NULL THEN
    SELECT * INTO doc FROM change_orders WHERE id = NEW.change_order_id;
    SELECT project_id INTO case_project FROM pricing_cases WHERE case_id = doc.case_id;
    SELECT * INTO rev FROM revisions WHERE id = doc.revision_id FOR SHARE;
    IF NEW.revision_id IS DISTINCT FROM doc.revision_id
       OR NEW.content_hash IS DISTINCT FROM doc.content_hash
       OR NEW.revision_content_hash IS DISTINCT FROM rev.content_hash
       OR NEW.project_id IS DISTINCT FROM case_project
       OR rev.project_id IS DISTINCT FROM NEW.project_id THEN
      RAISE EXCEPTION 'payment operation does not match the frozen client version it names' USING ERRCODE = 'check_violation';
    END IF;
    IF rev.status IS DISTINCT FROM 'approved' OR NOT EXISTS (
      SELECT 1 FROM change_order_decisions d
      WHERE d.order_id = doc.id AND d.decision = 'approved'
        AND d.content_hash = doc.content_hash AND d.revision_content_hash = rev.content_hash
    ) THEN
      RAISE EXCEPTION 'payment operations start only from the current client-confirmed version (V% is %)', rev.number, rev.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'payment item % belongs to another project', NEW.item_id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.authorization_id IS NOT NULL THEN
    IF auth.project_id IS DISTINCT FROM NEW.project_id OR (NEW.item_id IS NOT NULL AND auth.item_id IS NOT NULL AND auth.item_id IS DISTINCT FROM NEW.item_id) THEN
      RAISE EXCEPTION 'authorization % belongs to another project or item', auth.paypal_authorization_id USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM payment_operations WHERE authorization_id = NEW.authorization_id AND status IN ('pending', 'unknown')) THEN
      RAISE EXCEPTION 'authorization % has an unresolved operation; reconcile it before starting another', auth.paypal_authorization_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF auth.status IN ('voided', 'expired', 'captured') OR EXISTS (
      SELECT 1 FROM payment_operations WHERE authorization_id = NEW.authorization_id AND kind = 'void' AND status = 'succeeded'
    ) OR EXISTS (
      SELECT 1 FROM paypal_captures WHERE authorization_id = NEW.authorization_id AND final_capture AND status <> 'declined'
    ) THEN
      RAISE EXCEPTION 'authorization % is closed (%); nothing more can be captured or voided', auth.paypal_authorization_id, auth.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'capture' THEN
      SELECT COALESCE(SUM(amount_cents), 0) INTO used FROM paypal_captures WHERE authorization_id = NEW.authorization_id AND status <> 'declined';
      IF used + NEW.amount_cents > auth.amount_cents + LEAST(auth.amount_cents::bigint * 15 / 100, 7500) THEN
        RAISE EXCEPTION 'capture of % cents would exceed authorization % (% already captured of %)', NEW.amount_cents, auth.paypal_authorization_id, used, auth.amount_cents
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.capture_id IS NOT NULL THEN
    SELECT item_id INTO cap_item FROM paypal_authorizations WHERE id = cap.authorization_id;
    IF cap.project_id IS DISTINCT FROM NEW.project_id OR (NEW.item_id IS NOT NULL AND cap_item IS DISTINCT FROM NEW.item_id) THEN
      RAISE EXCEPTION 'capture % belongs to another project or item', cap.paypal_capture_id USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM payment_operations WHERE capture_id = NEW.capture_id AND status IN ('pending', 'unknown')) THEN
      RAISE EXCEPTION 'capture % has an unresolved refund; reconcile it before starting another', cap.paypal_capture_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF cap.status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'capture % is %; only completed captures can be refunded', cap.paypal_capture_id, cap.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(amount_cents), 0) INTO used FROM paypal_refunds WHERE capture_id = NEW.capture_id AND status <> 'failed';
    IF used + NEW.amount_cents > cap.amount_cents THEN
      RAISE EXCEPTION 'refund of % cents would exceed capture % (% already refunded of %)', NEW.amount_cents, cap.paypal_capture_id, used, cap.amount_cents
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.kind = 'authorize' AND EXISTS (
    SELECT 1 FROM payment_operations WHERE kind = 'authorize' AND item_id = NEW.item_id AND status IN ('pending', 'unknown')
  ) THEN
    RAISE EXCEPTION 'item % already has an unresolved authorization checkout', NEW.item_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION services_hold_lines_guard() RETURNS trigger AS $$
DECLARE
  op payment_operations%ROWTYPE;
  line_total bigint;
  split bigint;
BEGIN
  SELECT * INTO op FROM payment_operations WHERE id = NEW.operation_id FOR UPDATE;
  IF NOT op.services_hold OR op.status IS DISTINCT FROM 'pending' OR op.paypal_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'a design-services split is written with its hold, before checkout starts' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = op.project_id AND kind = 'service') THEN
    RAISE EXCEPTION 'only this project''s design services can share the design-services hold' USING ERRCODE = 'check_violation';
  END IF;
  IF op.change_order_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM approvals a JOIN revision_lines l ON l.id = a.revision_line_id
    WHERE a.revision_id = op.revision_id AND l.item_id = NEW.item_id AND a.decision = 'approved' AND a.content_hash = op.revision_content_hash
  ) THEN
    RAISE EXCEPTION 'the client has not approved this design service on quote V1' USING ERRCODE = 'check_violation';
  END IF;
  SELECT quantity::bigint * unit_price_cents + tax_cents + freight_cents INTO line_total FROM revision_lines WHERE revision_id = op.revision_id AND item_id = NEW.item_id;
  IF line_total IS NULL OR NEW.amount_cents > line_total THEN
    RAISE EXCEPTION 'a design service''s share cannot exceed its line in the version the hold is bound to' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(amount_cents), 0) INTO split FROM services_hold_lines WHERE operation_id = NEW.operation_id;
  IF split + NEW.amount_cents > op.amount_cents THEN
    RAISE EXCEPTION 'the design-services split exceeds its hold' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER services_hold_lines_guard
  BEFORE INSERT ON services_hold_lines
  FOR EACH ROW EXECUTE FUNCTION services_hold_lines_guard();
--> statement-breakpoint
CREATE TRIGGER services_hold_lines_append_only
  BEFORE UPDATE OR DELETE ON services_hold_lines
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paypal_authorizations_services_split() RETURNS trigger AS $$
DECLARE
  op payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO op FROM payment_operations WHERE id = NEW.operation_id;
  IF op.services_hold AND NEW.amount_cents IS DISTINCT FROM (SELECT SUM(amount_cents) FROM services_hold_lines WHERE operation_id = op.id) THEN
    RAISE EXCEPTION 'a design-services hold is recorded only when its split adds up to the hold' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER paypal_authorizations_services_split
  BEFORE INSERT ON paypal_authorizations
  FOR EACH ROW EXECUTE FUNCTION paypal_authorizations_services_split();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_services_guard() RETURNS trigger AS $$
DECLARE
  auth paypal_authorizations%ROWTYPE;
  hold_op payment_operations%ROWTYPE;
  share bigint;
  used bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM payment_operations WHERE business_key = NEW.business_key) THEN
    RETURN NEW;
  END IF;
  IF NEW.services_hold AND EXISTS (
    SELECT 1 FROM payment_operations WHERE project_id = NEW.project_id AND services_hold AND status IN ('pending', 'unknown')
  ) THEN
    RAISE EXCEPTION 'this project already has an open design-services checkout' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.authorization_id IS NOT NULL THEN
    SELECT * INTO auth FROM paypal_authorizations WHERE id = NEW.authorization_id;
    SELECT * INTO hold_op FROM payment_operations WHERE id = auth.operation_id;
  END IF;
  IF COALESCE(hold_op.services_hold, false) THEN
    IF NEW.kind <> 'capture' OR NEW.item_id IS NULL OR NEW.supplier_event_id IS NOT NULL
       OR NEW.revision_id IS DISTINCT FROM hold_op.revision_id OR NEW.change_order_id IS DISTINCT FROM hold_op.change_order_id THEN
      RAISE EXCEPTION 'the design-services hold only pays its design services, under the version it was placed for' USING ERRCODE = 'check_violation';
    END IF;
    SELECT amount_cents INTO share FROM services_hold_lines WHERE operation_id = hold_op.id AND item_id = NEW.item_id;
    SELECT COALESCE(SUM(amount_cents), 0) INTO used FROM paypal_captures WHERE authorization_id = auth.id AND item_id = NEW.item_id AND status <> 'declined';
    IF share IS NULL OR used + NEW.amount_cents > share THEN
      RAISE EXCEPTION 'capture of % cents exceeds what is left of this design service''s share', NEW.amount_cents USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'capture' AND NEW.change_order_id IS NOT NULL AND NEW.supplier_event_id IS NULL THEN
    RAISE EXCEPTION 'a capture waits for the supplier''s confirmation of this version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_services_guard
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_services_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paypal_captures_item() RETURNS trigger AS $$
DECLARE
  services boolean;
  op_item uuid;
BEGIN
  SELECT COALESCE(o.services_hold, false) INTO services FROM paypal_authorizations a LEFT JOIN payment_operations o ON o.id = a.operation_id WHERE a.id = NEW.authorization_id;
  SELECT item_id INTO op_item FROM payment_operations WHERE id = NEW.operation_id;
  IF (COALESCE(services, false) AND (NEW.item_id IS NULL OR NEW.item_id IS DISTINCT FROM op_item))
     OR (NOT COALESCE(services, false) AND NEW.item_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a capture from the design-services hold names the service it paid; other captures belong to their hold''s item' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER paypal_captures_item
  BEFORE INSERT ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION paypal_captures_item();
--> statement-breakpoint
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
  -- On V1, money moves are holds and the design services captured from their hold.
  IF NEW.kind <> 'authorize' AND NOT (NEW.kind = 'capture' AND EXISTS (
    SELECT 1 FROM paypal_authorizations a JOIN payment_operations o ON o.id = a.operation_id WHERE a.id = NEW.authorization_id AND o.services_hold
  )) THEN
    RAISE EXCEPTION 'a % cannot be bound to quote V1 yet', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER payment_operations_identity_immutable ON payment_operations;
--> statement-breakpoint
CREATE TRIGGER payment_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'kind', 'business_key', 'authorization_id', 'capture_id', 'amount_cents', 'currency', 'final_capture', 'change_order_id', 'revision_id', 'content_hash', 'revision_content_hash', 'item_id', 'supplier_event_id', 'request_id', 'created_at', 'save_payment_method', 'saved_method_id', 'services_hold');
--> statement-breakpoint
DROP TRIGGER paypal_captures_immutable ON paypal_captures;
--> statement-breakpoint
CREATE TRIGGER paypal_captures_immutable
  BEFORE UPDATE OR DELETE ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_capture_id', 'authorization_id', 'project_id', 'final_capture', 'currency', 'operation_id', 'created_at', 'item_id');
