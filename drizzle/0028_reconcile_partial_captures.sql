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

  -- A pending capture already reserved its amount before a later final capture.
  -- Reconciliation changes that record's status; only a new capture is forbidden.
  -- The amount sum, immutable identities and forward-status triggers still apply.
  IF TG_OP = 'INSERT' AND EXISTS (
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
