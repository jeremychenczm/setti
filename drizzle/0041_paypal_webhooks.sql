CREATE TABLE "paypal_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"resource_status" text,
	"amount_cents" integer,
	"operation_id" uuid,
	"paypal_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paypal_webhook_events" ADD CONSTRAINT "paypal_webhook_events_operation_id_payment_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER paypal_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON paypal_webhook_events
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('event_id', 'event_type', 'resource_id', 'resource_status', 'amount_cents', 'operation_id', 'paypal_created_at', 'received_at');
