ALTER TABLE "supplier_events" ALTER COLUMN "change_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_one_per_kind_on_v1" UNIQUE("revision_id","item_id","kind");--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_one_version" CHECK (("supplier_events"."change_order_id" IS NULL) <> ("supplier_events"."revision_id" IS NULL));--> statement-breakpoint
-- Supplier events on a V1 signed line by line:
--   1. They belong to the case's open V1 (no newer version replaced it), to the session that owns
--      the case, and to a line the client approved on it.
--   2. On V1 only order confirmations are recorded; credits follow a version that returns money.
--   3. A capture bound to V1 relies on that V1's order confirmation for the same item.
CREATE OR REPLACE FUNCTION supplier_events_match_version() RETURNS trigger AS $$
DECLARE
  doc change_orders%ROWTYPE;
  rev revisions%ROWTYPE;
  owner_session uuid;
  case_project uuid;
  opening_case uuid;
BEGIN
  IF NEW.change_order_id IS NOT NULL THEN
    SELECT * INTO doc FROM change_orders WHERE id = NEW.change_order_id;
    SELECT session_id INTO owner_session FROM chat_cases WHERE id = doc.case_id;
    SELECT project_id INTO case_project FROM pricing_cases WHERE case_id = doc.case_id;
    SELECT * INTO rev FROM revisions WHERE id = doc.revision_id FOR SHARE;
    IF NEW.project_id IS DISTINCT FROM case_project OR NEW.session_id IS DISTINCT FROM owner_session
       OR NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'supplier event does not belong to this demo case and project' USING ERRCODE = 'check_violation';
    END IF;
    IF rev.status IS DISTINCT FROM 'approved' OR NOT EXISTS (
      SELECT 1 FROM change_order_decisions d WHERE d.order_id = doc.id AND d.decision = 'approved' AND d.content_hash = doc.content_hash
    ) THEN
      RAISE EXCEPTION 'supplier events are recorded only for the current client-confirmed version (V% is %)', rev.number, rev.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO rev FROM revisions WHERE id = NEW.revision_id FOR SHARE;
  SELECT case_id, project_id INTO opening_case, case_project FROM pricing_cases WHERE baseline_revision_id = rev.id;
  SELECT session_id INTO owner_session FROM chat_cases WHERE id = opening_case;
  IF opening_case IS NULL OR NOT EXISTS (SELECT 1 FROM opening_quotes WHERE case_id = opening_case)
     OR NEW.project_id IS DISTINCT FROM case_project OR NEW.session_id IS DISTINCT FROM owner_session
     OR NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'supplier event does not belong to this demo case and project' USING ERRCODE = 'check_violation';
  END IF;
  IF rev.status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'supplier events are recorded only for the current client-confirmed version (V% is %)', rev.number, rev.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM approvals a JOIN revision_lines l ON l.id = a.revision_line_id
    WHERE a.revision_id = rev.id AND l.item_id = NEW.item_id AND a.decision = 'approved' AND a.content_hash = rev.content_hash
  ) THEN
    RAISE EXCEPTION 'the client has not approved this line of quote V1' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> 'order_confirmed' THEN
    RAISE EXCEPTION 'on quote V1 only order confirmations are recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_supplier_event() RETURNS trigger AS $$
DECLARE
  event supplier_events%ROWTYPE;
  expected text;
BEGIN
  IF NEW.supplier_event_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO event FROM supplier_events WHERE id = NEW.supplier_event_id;
  expected := CASE NEW.kind WHEN 'capture' THEN 'order_confirmed' WHEN 'refund' THEN 'credit_confirmed' END;
  IF event.change_order_id IS DISTINCT FROM NEW.change_order_id
     OR (NEW.change_order_id IS NULL AND event.revision_id IS DISTINCT FROM NEW.revision_id)
     OR event.item_id IS DISTINCT FROM NEW.item_id OR event.kind IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'payment operation relies on a supplier event of another version, item or kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
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
  -- On V1, money moves are holds, the design services captured from their hold, and items
  -- captured after the supplier confirmed them on V1.
  IF NEW.kind <> 'authorize' AND NOT (NEW.kind = 'capture' AND (NEW.supplier_event_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM paypal_authorizations a JOIN payment_operations o ON o.id = a.operation_id WHERE a.id = NEW.authorization_id AND o.services_hold
  ))) THEN
    RAISE EXCEPTION 'a % cannot be bound to quote V1 yet', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
