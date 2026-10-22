CREATE TABLE "supplier_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"change_order_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer,
	"unit_price_cents" integer,
	"tax_cents" integer,
	"freight_cents" integer,
	"in_stock" boolean,
	"lead_time_days" integer,
	"total_cents" integer NOT NULL,
	"reference" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"is_demo" boolean DEFAULT true NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_events_one_per_kind" UNIQUE("change_order_id","item_id","kind"),
	CONSTRAINT "supplier_events_kind_valid" CHECK ("supplier_events"."kind" IN ('order_confirmed', 'credit_confirmed')),
	CONSTRAINT "supplier_events_demo" CHECK ("supplier_events"."is_demo"),
	CONSTRAINT "supplier_events_reference" CHECK (length(btrim("supplier_events"."reference")) > 0),
	CONSTRAINT "supplier_events_total" CHECK ("supplier_events"."total_cents" >= 0),
	CONSTRAINT "supplier_events_terms" CHECK (("supplier_events"."kind" = 'order_confirmed' AND "supplier_events"."quantity" >= 1 AND "supplier_events"."unit_price_cents" >= 0 AND "supplier_events"."tax_cents" >= 0 AND "supplier_events"."freight_cents" >= 0 AND "supplier_events"."in_stock" IS TRUE AND "supplier_events"."total_cents" = "supplier_events"."quantity" * "supplier_events"."unit_price_cents" + "supplier_events"."tax_cents" + "supplier_events"."freight_cents")
      OR ("supplier_events"."kind" = 'credit_confirmed' AND "supplier_events"."quantity" IS NULL AND "supplier_events"."unit_price_cents" IS NULL AND "supplier_events"."tax_cents" IS NULL AND "supplier_events"."freight_cents" IS NULL AND "supplier_events"."in_stock" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD COLUMN "supplier_event_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_supplier_event_id_supplier_events_id_fk" FOREIGN KEY ("supplier_event_id") REFERENCES "public"."supplier_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_capture_after_supplier" CHECK ("payment_operations"."kind" <> 'capture' OR "payment_operations"."change_order_id" IS NULL OR "payment_operations"."supplier_event_id" IS NOT NULL);