CREATE TYPE "public"."operation_kind" AS ENUM('capture', 'void', 'refund', 'authorize', 'reauthorize');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('pending', 'succeeded', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "payment_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "operation_kind" NOT NULL,
	"status" "operation_status" DEFAULT 'pending' NOT NULL,
	"authorization_id" uuid,
	"amount_cents" integer NOT NULL,
	"final_capture" boolean DEFAULT false NOT NULL,
	"request_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"paypal_resource_id" text,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_operations_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "payment_operations_amount_positive" CHECK ("payment_operations"."amount_cents" > 0),
	CONSTRAINT "payment_operations_capture_has_authorization" CHECK ("payment_operations"."kind" <> 'capture' OR "payment_operations"."authorization_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_authorization_id_paypal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."paypal_authorizations"("id") ON DELETE no action ON UPDATE no action;