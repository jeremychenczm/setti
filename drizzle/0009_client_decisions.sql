CREATE TABLE "change_order_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"client_name" text NOT NULL,
	"signature" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"revision_content_hash" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_order_decisions_one_per_order" UNIQUE("order_id"),
	CONSTRAINT "change_order_decisions_one_per_revision" UNIQUE("revision_id"),
	CONSTRAINT "change_order_decisions_valid_decision" CHECK ("change_order_decisions"."decision" IN ('approved', 'changes_requested')),
	CONSTRAINT "change_order_decisions_named" CHECK (length(trim("change_order_decisions"."signature")) > 0 AND "change_order_decisions"."signature" = "change_order_decisions"."client_name"),
	CONSTRAINT "change_order_decisions_changes_note" CHECK ("change_order_decisions"."decision" <> 'changes_requested' OR length(trim("change_order_decisions"."note")) > 0)
);
--> statement-breakpoint
ALTER TABLE "change_order_decisions" ADD CONSTRAINT "change_order_decisions_order_id_change_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."change_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_decisions" ADD CONSTRAINT "change_order_decisions_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;
