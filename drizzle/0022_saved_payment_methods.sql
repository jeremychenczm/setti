CREATE TABLE "saved_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_operation_id" uuid NOT NULL,
	"paypal_token_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_payment_methods_source_operation_id_unique" UNIQUE("source_operation_id"),
	CONSTRAINT "saved_payment_methods_paypal_token_id_unique" UNIQUE("paypal_token_id"),
	CONSTRAINT "saved_payment_methods_one_per_project" UNIQUE("project_id"),
	CONSTRAINT "saved_payment_methods_token" CHECK (length(btrim("saved_payment_methods"."paypal_token_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "save_payment_method" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "saved_method_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_payment_methods" ADD CONSTRAINT "saved_payment_methods_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_payment_methods" ADD CONSTRAINT "saved_payment_methods_source_operation_id_payment_operations_id_fk" FOREIGN KEY ("source_operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_saved_method_id_saved_payment_methods_id_fk" FOREIGN KEY ("saved_method_id") REFERENCES "public"."saved_payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_save_on_checkout" CHECK (NOT "payment_operations"."save_payment_method" OR ("payment_operations"."kind" = 'authorize' AND "payment_operations"."saved_method_id" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_saved_method_holds" CHECK ("payment_operations"."saved_method_id" IS NULL OR ("payment_operations"."kind" = 'authorize' AND "payment_operations"."approval_url" IS NULL));--> statement-breakpoint
-- Saved PayPal rules enforced by the database:
--   1. PayPal is saved only from this project's own checkout that asked to save it and succeeded.
--   2. A saved payment method is a record: never changed or deleted.
--   3. A hold placed with saved PayPal uses this project's saved PayPal, never another project's.
--   4. Whether an operation saves PayPal, or which saved PayPal it uses, never changes.
CREATE OR REPLACE FUNCTION saved_payment_methods_guard() RETURNS trigger AS $$
DECLARE
  source payment_operations%ROWTYPE;
BEGIN
  SELECT * INTO source FROM payment_operations WHERE id = NEW.source_operation_id FOR SHARE;
  IF source.project_id IS DISTINCT FROM NEW.project_id OR source.kind IS DISTINCT FROM 'authorize'
     OR NOT source.save_payment_method OR source.status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'PayPal is saved only from a succeeded checkout of this project that asked to save it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER saved_payment_methods_guard
  BEFORE INSERT ON saved_payment_methods
  FOR EACH ROW EXECUTE FUNCTION saved_payment_methods_guard();
--> statement-breakpoint
CREATE TRIGGER saved_payment_methods_immutable
  BEFORE UPDATE OR DELETE ON saved_payment_methods
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'source_operation_id', 'paypal_token_id', 'created_at');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION payment_operations_saved_method_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.saved_method_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM saved_payment_methods WHERE id = NEW.saved_method_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'saved PayPal belongs to another project' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_operations_saved_method_guard
  BEFORE INSERT ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION payment_operations_saved_method_guard();
--> statement-breakpoint
DROP TRIGGER payment_operations_identity_immutable ON payment_operations;
--> statement-breakpoint
CREATE TRIGGER payment_operations_identity_immutable
  BEFORE UPDATE OR DELETE ON payment_operations
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('id', 'project_id', 'kind', 'business_key', 'authorization_id', 'capture_id', 'amount_cents', 'currency', 'final_capture', 'change_order_id', 'revision_id', 'content_hash', 'revision_content_hash', 'item_id', 'supplier_event_id', 'request_id', 'created_at', 'save_payment_method', 'saved_method_id');
