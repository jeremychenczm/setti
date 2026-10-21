-- Payment execution rules enforced by the database:
--   1. A bound operation executes the current client-confirmed version it names, with both
--      frozen hashes, and touches only items, holds and captures of that version's project.
--   2. A hold or capture has at most one unresolved operation; nothing is captured or voided
--      once a hold is closed, and amounts never exceed what the hold or capture allows.
--   3. An operation's identity never changes and its outcome, once final, stays final.
--   4. Money records written by an operation match it exactly; their statuses only move forward.
-- Parent rows are locked first, so concurrent requests are checked one at a time.

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
    IF auth.project_id IS DISTINCT FROM NEW.project_id OR (NEW.item_id IS NOT NULL AND auth.item_id IS DISTINCT FROM NEW.item_id) THEN
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
CREATE TRIGGER payment_operations_guard
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_guard();
--> statement-breakpoint
CREATE TRIGGER payment_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'kind', 'business_key', 'authorization_id', 'capture_id', 'amount_cents', 'currency', 'final_capture', 'change_order_id', 'revision_id', 'content_hash', 'revision_content_hash', 'item_id', 'request_id', 'created_at');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_forward() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'payment operation % is already %; its outcome is final', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.paypal_order_id IS NOT NULL AND NEW.paypal_order_id IS DISTINCT FROM OLD.paypal_order_id)
     OR (OLD.approval_url IS NOT NULL AND NEW.approval_url IS DISTINCT FROM OLD.approval_url)
     OR (OLD.paypal_resource_id IS NOT NULL AND NEW.paypal_resource_id IS DISTINCT FROM OLD.paypal_resource_id)
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'recorded PayPal references of payment operation % cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_forward
  BEFORE UPDATE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_forward();
--> statement-breakpoint
DROP TRIGGER paypal_authorizations_immutable ON paypal_authorizations;
--> statement-breakpoint
CREATE TRIGGER paypal_authorizations_immutable
  BEFORE UPDATE OR DELETE ON paypal_authorizations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_authorization_id', 'paypal_order_id', 'project_id', 'reauthorized_from_id', 'item_id', 'currency', 'change_order_id', 'operation_id', 'created_at');
--> statement-breakpoint
DROP TRIGGER paypal_captures_immutable ON paypal_captures;
--> statement-breakpoint
CREATE TRIGGER paypal_captures_immutable
  BEFORE UPDATE OR DELETE ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_capture_id', 'authorization_id', 'project_id', 'final_capture', 'currency', 'operation_id', 'created_at');
--> statement-breakpoint
DROP TRIGGER paypal_refunds_immutable ON paypal_refunds;
--> statement-breakpoint
CREATE TRIGGER paypal_refunds_immutable
  BEFORE UPDATE OR DELETE ON paypal_refunds
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_refund_id', 'capture_id', 'currency', 'operation_id', 'created_at');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION money_status_forward() RETURNS trigger AS $$
DECLARE
  old_status text := OLD.status::text;
  new_status text := NEW.status::text;
  allowed boolean;
BEGIN
  IF new_status = old_status THEN
    RETURN NEW;
  END IF;
  allowed := CASE TG_TABLE_NAME
    WHEN 'paypal_authorizations' THEN (old_status = 'created' AND new_status IN ('partially_captured', 'captured', 'voided', 'expired'))
      OR (old_status = 'partially_captured' AND new_status IN ('captured', 'voided', 'expired'))
    WHEN 'paypal_captures' THEN old_status = 'pending' AND new_status IN ('completed', 'declined')
    WHEN 'paypal_refunds' THEN old_status = 'pending' AND new_status IN ('completed', 'failed')
    ELSE false
  END;
  IF NOT allowed THEN
    RAISE EXCEPTION '% status cannot go from % to %', TG_TABLE_NAME, old_status, new_status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER paypal_authorizations_status_forward
  BEFORE UPDATE OF status ON paypal_authorizations
  FOR EACH ROW EXECUTE FUNCTION money_status_forward();
--> statement-breakpoint
CREATE TRIGGER paypal_captures_status_forward
  BEFORE UPDATE OF status ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION money_status_forward();
--> statement-breakpoint
CREATE TRIGGER paypal_refunds_status_forward
  BEFORE UPDATE OF status ON paypal_refunds
  FOR EACH ROW EXECUTE FUNCTION money_status_forward();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION money_records_match_operation() RETURNS trigger AS $$
DECLARE
  op payment_operations%ROWTYPE;
  matches boolean;
BEGIN
  IF NEW.operation_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO op FROM payment_operations WHERE id = NEW.operation_id;
  -- Separate branches: each table's columns are only read for that table.
  IF TG_TABLE_NAME = 'paypal_authorizations' THEN
    matches := op.kind = 'authorize' AND op.project_id = NEW.project_id AND op.item_id IS NOT DISTINCT FROM NEW.item_id
      AND op.amount_cents = NEW.amount_cents AND op.currency = NEW.currency
      AND op.change_order_id IS NOT DISTINCT FROM NEW.change_order_id AND op.paypal_order_id IS NOT DISTINCT FROM NEW.paypal_order_id;
  ELSIF TG_TABLE_NAME = 'paypal_captures' THEN
    matches := op.kind = 'capture' AND op.project_id = NEW.project_id AND op.authorization_id IS NOT DISTINCT FROM NEW.authorization_id
      AND op.amount_cents = NEW.amount_cents AND op.currency = NEW.currency AND op.final_capture = NEW.final_capture;
  ELSIF TG_TABLE_NAME = 'paypal_refunds' THEN
    matches := op.kind = 'refund' AND op.capture_id IS NOT DISTINCT FROM NEW.capture_id
      AND op.amount_cents = NEW.amount_cents AND op.currency = NEW.currency;
  END IF;
  IF NOT COALESCE(matches, false) THEN
    RAISE EXCEPTION '% record does not match payment operation %', TG_TABLE_NAME, NEW.operation_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER paypal_authorizations_match_operation
  BEFORE INSERT ON paypal_authorizations
  FOR EACH ROW EXECUTE FUNCTION money_records_match_operation();
--> statement-breakpoint
CREATE TRIGGER paypal_captures_match_operation
  BEFORE INSERT ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION money_records_match_operation();
--> statement-breakpoint
CREATE TRIGGER paypal_refunds_match_operation
  BEFORE INSERT ON paypal_refunds
  FOR EACH ROW EXECUTE FUNCTION money_records_match_operation();
--> statement-breakpoint
CREATE TRIGGER paypal_calls_append_only
  BEFORE UPDATE OR DELETE ON paypal_calls
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
