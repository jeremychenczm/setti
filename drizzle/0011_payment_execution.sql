CREATE TABLE "paypal_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"step" text NOT NULL,
	"request_id" text,
	"outcome" text NOT NULL,
	"http_status" integer,
	"debug_id" text,
	"resource_id" text,
	"resource_status" text,
	"amount_cents" integer,
	"currency" text,
	"error_code" text,
	"message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_calls_outcome_valid" CHECK ("paypal_calls"."outcome" IN ('ok', 'rejected', 'unknown', 'retryable')),
	CONSTRAINT "paypal_calls_step_valid" CHECK ("paypal_calls"."step" IN ('create_order', 'get_order', 'authorize_order', 'get_authorization', 'capture', 'get_capture', 'void', 'refund', 'get_refund'))
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "business_key" text;--> statement-breakpoint
-- Operations written before business keys existed keep a unique key of their own.
UPDATE "payment_operations" SET "business_key" = 'legacy:' || "id"::text WHERE "business_key" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ALTER COLUMN "business_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "capture_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "change_order_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "revision_content_hash" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "paypal_order_id" text;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "approval_url" text;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD COLUMN "change_order_id" uuid;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "paypal_calls" ADD CONSTRAINT "paypal_calls_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_capture_id_paypal_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."paypal_captures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD CONSTRAINT "paypal_refunds_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_business_key_unique" UNIQUE("business_key");--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_operation_id_unique" UNIQUE("operation_id");--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_operation_id_unique" UNIQUE("operation_id");--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD CONSTRAINT "paypal_refunds_operation_id_unique" UNIQUE("operation_id");--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_usd" CHECK ("payment_operations"."currency" = 'USD');--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_refund_has_capture" CHECK ("payment_operations"."kind" <> 'refund' OR "payment_operations"."capture_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_authorize_is_bound" CHECK ("payment_operations"."kind" <> 'authorize' OR "payment_operations"."change_order_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_binding_complete" CHECK (("payment_operations"."change_order_id" IS NULL AND "payment_operations"."revision_id" IS NULL AND "payment_operations"."content_hash" IS NULL AND "payment_operations"."revision_content_hash" IS NULL) OR ("payment_operations"."change_order_id" IS NOT NULL AND "payment_operations"."revision_id" IS NOT NULL AND "payment_operations"."content_hash" IS NOT NULL AND "payment_operations"."revision_content_hash" IS NOT NULL AND "payment_operations"."item_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_usd" CHECK ("paypal_authorizations"."currency" = 'USD');--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_usd" CHECK ("paypal_captures"."currency" = 'USD');--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD CONSTRAINT "paypal_refunds_usd" CHECK ("paypal_refunds"."currency" = 'USD');