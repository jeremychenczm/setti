CREATE TABLE "try_seeds" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'seeding' NOT NULL,
	"change_order_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "try_seeds_status_valid" CHECK ("try_seeds"."status" IN ('seeding', 'ready', 'failed')),
	CONSTRAINT "try_seeds_ready_has_order" CHECK ("try_seeds"."status" <> 'ready' OR "try_seeds"."change_order_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "try_seeds" ADD CONSTRAINT "try_seeds_change_order_id_change_orders_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "try_seeds_created_at" ON "try_seeds" USING btree ("created_at");