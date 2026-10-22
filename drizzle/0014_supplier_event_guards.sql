-- Supplier event rules enforced by the database:
--   1. A supplier event is recorded only for the current client-confirmed version, by the
--      session that owns its demo case, for a business item of that version's project.
--   2. Supplier events are a record: never changed or deleted.
--   3. A capture relies on that version's order confirmation for the same item, and a refund
--      may wait only on that version's credit for the same item.

CREATE OR REPLACE FUNCTION supplier_events_match_version() RETURNS trigger AS $$
DECLARE
  doc change_orders%ROWTYPE;
  rev revisions%ROWTYPE;
  owner_session uuid;
  case_project uuid;
BEGIN
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
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER supplier_events_match_version
  BEFORE INSERT ON supplier_events
  FOR EACH ROW EXECUTE FUNCTION supplier_events_match_version();
--> statement-breakpoint
CREATE TRIGGER supplier_events_append_only
  BEFORE UPDATE OR DELETE ON supplier_events
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
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
  IF event.change_order_id IS DISTINCT FROM NEW.change_order_id OR event.item_id IS DISTINCT FROM NEW.item_id
     OR event.kind IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'payment operation relies on a supplier event of another version, item or kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_supplier_event
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_supplier_event();
--> statement-breakpoint
DROP TRIGGER payment_operations_identity_immutable ON payment_operations;
--> statement-breakpoint
CREATE TRIGGER payment_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'kind', 'business_key', 'authorization_id', 'capture_id', 'amount_cents', 'currency', 'final_capture', 'change_order_id', 'revision_id', 'content_hash', 'revision_content_hash', 'item_id', 'supplier_event_id', 'request_id', 'created_at');
