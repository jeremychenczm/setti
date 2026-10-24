-- A shared design-services authorization has no item. Refund ownership comes from
-- the service capture itself, falling back to the authorization for furniture.
-- Preserve the existing project, unresolved-operation and remaining-balance checks.
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
    -- Service captures name their own item; furniture captures inherit their hold's item.
    SELECT COALESCE(cap.item_id, a.item_id) INTO cap_item
      FROM paypal_authorizations a WHERE a.id = cap.authorization_id;
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
-- A saved-PayPal order may need its payer-action URL when PayPal asks the client
-- to approve again. It remains an authorization of the same operation and item.
ALTER TABLE "payment_operations" DROP CONSTRAINT "payment_operations_saved_method_holds";
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_saved_method_holds"
  CHECK ("payment_operations"."saved_method_id" IS NULL OR "payment_operations"."kind" = 'authorize');
--> statement-breakpoint
-- Older code treated a saved-PayPal order needing buyer approval as a final
-- failure. Its existing order can still be approved, so restore reconciliation
-- without changing its order, request id, amount or binding. Multiple attempts
-- on the item require manual review before any further provider action.
-- This block is atomic: the final-state trigger is disabled only for this exact
-- data repair and is restored before the block returns (or by rollback on error).
DO $legacy_saved_holds$
BEGIN
  ALTER TABLE payment_operations DISABLE TRIGGER payment_operations_forward;

  WITH legacy AS MATERIALIZED (
    SELECT op.id, EXISTS (
      SELECT 1 FROM payment_operations peer
      WHERE peer.id <> op.id AND peer.project_id = op.project_id
        AND peer.item_id = op.item_id AND peer.kind = 'authorize'
        AND (peer.status IN ('pending', 'unknown') OR peer.created_at >= op.created_at
          OR (peer.saved_method_id IS NOT NULL AND peer.failure_code = 'SAVED_PAYPAL_NEEDS_CLIENT'))
    ) AS needs_manual_review
    FROM payment_operations op
    WHERE op.kind = 'authorize' AND op.saved_method_id IS NOT NULL
      AND op.status = 'failed' AND op.failure_code = 'SAVED_PAYPAL_NEEDS_CLIENT'
      AND op.paypal_order_id IS NOT NULL AND op.paypal_resource_id IS NULL
      AND op.authorization_id IS NULL AND op.capture_id IS NULL
      AND op.item_id IS NOT NULL AND NOT op.services_hold
      AND NOT EXISTS (
        SELECT 1 FROM paypal_authorizations auth
        WHERE auth.operation_id = op.id OR auth.paypal_order_id = op.paypal_order_id
      )
  )
  UPDATE payment_operations op
  SET status = 'unknown',
      failure_code = CASE WHEN legacy.needs_manual_review
        THEN 'LEGACY_SAVED_PAYPAL_REVIEW_REQUIRED' ELSE 'SAVED_PAYPAL_NEEDS_CHECK' END,
      failure_message = CASE WHEN legacy.needs_manual_review
        THEN 'This item has multiple authorization attempts. The original PayPal orders need manual review; no automatic authorization or replacement is allowed.'
        ELSE 'An earlier version marked this PayPal approval order failed. Check the original order before continuing; no replacement hold may be created.' END,
      updated_at = now()
  FROM legacy WHERE op.id = legacy.id;

  ALTER TABLE payment_operations ENABLE TRIGGER payment_operations_forward;
END
$legacy_saved_holds$;
