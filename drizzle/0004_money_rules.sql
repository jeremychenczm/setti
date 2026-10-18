-- Money rules enforced by the database:
--   1. Captures on a hold never exceed its amount plus PayPal's allowance
--      (15% or $75, whichever is less, rounded down), and nothing is captured
--      after a final capture or from a voided or expired hold.
--   2. Refunds of a capture never add up to more than the capture, and only
--      completed captures can be refunded.
--   3. Recorded amounts and PayPal ids never change, and money records are never deleted.
-- Each check locks the parent row, so concurrent writes are checked one at a time.

CREATE OR REPLACE FUNCTION captures_within_authorization() RETURNS trigger AS $$
DECLARE
  auth paypal_authorizations%ROWTYPE;
  captured bigint;
  allowance bigint;
BEGIN
  IF NEW.authorization_id IS NULL OR NEW.status = 'declined' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO auth FROM paypal_authorizations WHERE id = NEW.authorization_id FOR UPDATE;
  IF auth.status IN ('voided', 'expired') THEN
    RAISE EXCEPTION 'authorization % is %; nothing can be captured from it', auth.paypal_authorization_id, auth.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM paypal_captures
    WHERE authorization_id = NEW.authorization_id AND final_capture AND status <> 'declined' AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'authorization % already had its final capture', auth.paypal_authorization_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO captured FROM paypal_captures
  WHERE authorization_id = NEW.authorization_id AND status <> 'declined' AND id <> NEW.id;
  allowance := LEAST(auth.amount_cents::bigint * 15 / 100, 7500);

  IF captured + NEW.amount_cents > auth.amount_cents + allowance THEN
    RAISE EXCEPTION 'captures would exceed authorization %: % + % cents is more than % + % allowed',
      auth.paypal_authorization_id, captured, NEW.amount_cents, auth.amount_cents, allowance
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER captures_within_authorization
  BEFORE INSERT OR UPDATE OF status, authorization_id ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION captures_within_authorization();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refunds_within_capture() RETURNS trigger AS $$
DECLARE
  cap paypal_captures%ROWTYPE;
  refunded bigint;
BEGIN
  IF NEW.status = 'failed' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO cap FROM paypal_captures WHERE id = NEW.capture_id FOR UPDATE;
  IF cap.status <> 'completed' THEN
    RAISE EXCEPTION 'capture % is %; only completed captures can be refunded', cap.paypal_capture_id, cap.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0) INTO refunded FROM paypal_refunds
  WHERE capture_id = NEW.capture_id AND status <> 'failed' AND id <> NEW.id;

  IF refunded + NEW.amount_cents > cap.amount_cents THEN
    RAISE EXCEPTION 'refunds would exceed capture %: % + % cents is more than %',
      cap.paypal_capture_id, refunded, NEW.amount_cents, cap.amount_cents
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER refunds_within_capture
  BEFORE INSERT OR UPDATE OF status, capture_id ON paypal_refunds
  FOR EACH ROW EXECUTE FUNCTION refunds_within_capture();
--> statement-breakpoint
-- Trigger arguments name the columns that must never change after a record is written.
CREATE OR REPLACE FUNCTION money_facts_immutable() RETURNS trigger AS $$
DECLARE
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% records cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION 'recorded % cannot change on %', col, TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER paypal_authorizations_immutable
  BEFORE UPDATE OR DELETE ON paypal_authorizations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_authorization_id', 'paypal_order_id', 'project_id', 'reauthorized_from_id');
--> statement-breakpoint
CREATE TRIGGER paypal_captures_immutable
  BEFORE UPDATE OR DELETE ON paypal_captures
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_capture_id', 'authorization_id', 'project_id', 'final_capture');
--> statement-breakpoint
CREATE TRIGGER paypal_refunds_immutable
  BEFORE UPDATE OR DELETE ON paypal_refunds
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('amount_cents', 'paypal_refund_id', 'capture_id');
