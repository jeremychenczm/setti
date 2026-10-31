CREATE TABLE "saved_payment_method_removals" (
	"method_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_payment_methods" DROP CONSTRAINT "saved_payment_methods_one_per_project";--> statement-breakpoint
ALTER TABLE "saved_payment_methods" ADD COLUMN "kind" text DEFAULT 'paypal' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_payment_methods" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "saved_payment_method_removals" ADD CONSTRAINT "saved_payment_method_removals_method_id_saved_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."saved_payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_payment_method_removals" ADD CONSTRAINT "saved_payment_method_removals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_payment_methods" ADD CONSTRAINT "saved_payment_methods_kind" CHECK ("saved_payment_methods"."kind" in ('paypal', 'card'));--> statement-breakpoint
-- Saved payment method rules enforced by the database:
--   1. A method is saved only from this project's own checkout that asked to save it and succeeded (as before).
--   2. A project has at most one active (not removed) saved method; after removing it, a new one may be saved.
--   3. A saved method and its removal are records: never changed or deleted.
--   4. A removal belongs to the method's own project.
--   5. A hold placed with a saved method uses this project's active method (rules from 0025 still apply).
CREATE OR REPLACE FUNCTION saved_payment_methods_guard() RETURNS trigger AS $$
DECLARE
  source payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO source FROM payment_operations WHERE id = NEW.source_operation_id FOR SHARE;
  IF source.project_id IS DISTINCT FROM NEW.project_id OR source.kind IS DISTINCT FROM 'authorize'
     OR NOT source.save_payment_method OR source.status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'a payment method is saved only from a succeeded checkout of this project that asked to save it' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialises concurrent saves of the same project.
  PERFORM 1 FROM projects WHERE id = NEW.project_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM saved_payment_methods method
    WHERE method.project_id = NEW.project_id
      AND NOT EXISTS (SELECT 1 FROM saved_payment_method_removals removal WHERE removal.method_id = method.id)
  ) THEN
    RAISE EXCEPTION 'this project already has an active saved payment method' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER saved_payment_methods_immutable ON saved_payment_methods;
--> statement-breakpoint
CREATE TRIGGER saved_payment_methods_immutable
  BEFORE UPDATE OR DELETE ON saved_payment_methods
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'source_operation_id', 'paypal_token_id', 'kind', 'label', 'created_at');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION saved_payment_method_removals_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM saved_payment_methods WHERE id = NEW.method_id AND project_id = NEW.project_id) THEN
    RAISE EXCEPTION 'a removal belongs to the saved payment method''s own project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER saved_payment_method_removals_guard
  BEFORE INSERT ON saved_payment_method_removals
  FOR EACH ROW EXECUTE FUNCTION saved_payment_method_removals_guard();
--> statement-breakpoint
CREATE TRIGGER saved_payment_method_removals_immutable
  BEFORE UPDATE OR DELETE ON saved_payment_method_removals
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('method_id', 'project_id', 'removed_at');
--> statement-breakpoint
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
  IF EXISTS (SELECT 1 FROM saved_payment_method_removals WHERE method_id = NEW.saved_method_id) THEN
    RAISE EXCEPTION 'the client removed this saved payment method' USING ERRCODE = 'check_violation';
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
