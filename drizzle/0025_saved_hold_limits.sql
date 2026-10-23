-- Holds placed with saved PayPal need no buyer on PayPal, so the database also limits them:
--   1. They use this project's saved PayPal (as before).
--   2. They hold a furniture item, never a design service (those share the design-services hold).
--   3. They hold at most that item's line in the version they are bound to.
CREATE OR REPLACE FUNCTION payment_operations_saved_method_guard() RETURNS trigger AS $$
DECLARE
  line_total bigint;
BEGIN
  IF NEW.saved_method_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM saved_payment_methods WHERE id = NEW.saved_method_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'saved PayPal belongs to another project' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND project_id = NEW.project_id AND kind = 'furniture') THEN
    RAISE EXCEPTION 'saved PayPal holds only this project''s furniture items' USING ERRCODE = 'check_violation';
  END IF;
  SELECT quantity::bigint * unit_price_cents + tax_cents + freight_cents INTO line_total FROM revision_lines WHERE revision_id = NEW.revision_id AND item_id = NEW.item_id;
  IF line_total IS NULL OR NEW.amount_cents > line_total THEN
    RAISE EXCEPTION 'a hold with saved PayPal cannot exceed the item''s line in the version it is bound to' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
