CREATE TYPE "public"."authorization_status" AS ENUM('created', 'partially_captured', 'captured', 'voided', 'expired');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('completed', 'pending', 'declined');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "paypal_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_id" uuid,
	"paypal_order_id" text NOT NULL,
	"paypal_authorization_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "authorization_status" DEFAULT 'created' NOT NULL,
	"honor_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"reauthorized_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_authorizations_paypal_authorization_id_unique" UNIQUE("paypal_authorization_id"),
	CONSTRAINT "paypal_authorizations_amount_positive" CHECK ("paypal_authorizations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "paypal_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"authorization_id" uuid,
	"paypal_capture_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"final_capture" boolean DEFAULT false NOT NULL,
	"status" "capture_status" DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_captures_paypal_capture_id_unique" UNIQUE("paypal_capture_id"),
	CONSTRAINT "paypal_captures_amount_positive" CHECK ("paypal_captures"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "paypal_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL,
	"paypal_refund_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paypal_refunds_paypal_refund_id_unique" UNIQUE("paypal_refund_id"),
	CONSTRAINT "paypal_refunds_amount_positive" CHECK ("paypal_refunds"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_authorizations" ADD CONSTRAINT "paypal_authorizations_reauthorized_from_id_paypal_authorizations_id_fk" FOREIGN KEY ("reauthorized_from_id") REFERENCES "public"."paypal_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_captures" ADD CONSTRAINT "paypal_captures_authorization_id_paypal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."paypal_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paypal_refunds" ADD CONSTRAINT "paypal_refunds_capture_id_paypal_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."paypal_captures"("id") ON DELETE no action ON UPDATE no action;