CREATE TYPE "public"."decision" AS ENUM('approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('furniture', 'service');--> statement-breakpoint
CREATE TYPE "public"."revision_status" AS ENUM('draft', 'sent', 'approved', 'declined', 'superseded');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision_line_id" uuid NOT NULL,
	"decision" "decision" NOT NULL,
	"approver_name" text NOT NULL,
	"signature" text NOT NULL,
	"content_hash" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_one_per_line" UNIQUE("revision_line_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vendor" text NOT NULL,
	"kind" "item_kind" DEFAULT 'furniture' NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"freight_cents" integer DEFAULT 0 NOT NULL,
	"restocking_fee_bps" integer,
	"returnable" boolean DEFAULT true NOT NULL,
	"custom_made" boolean DEFAULT false NOT NULL,
	"lead_time_days" integer,
	CONSTRAINT "revision_lines_one_per_item" UNIQUE("revision_id","item_id"),
	CONSTRAINT "revision_lines_quantity_positive" CHECK ("revision_lines"."quantity" >= 1),
	CONSTRAINT "revision_lines_amounts_not_negative" CHECK ("revision_lines"."unit_price_cents" >= 0 AND "revision_lines"."tax_cents" >= 0 AND "revision_lines"."freight_cents" >= 0),
	CONSTRAINT "revision_lines_restocking_range" CHECK ("revision_lines"."restocking_fee_bps" IS NULL OR "revision_lines"."restocking_fee_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"based_on_revision_id" uuid,
	"status" "revision_status" DEFAULT 'draft' NOT NULL,
	"content_hash" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revisions_project_number" UNIQUE("project_id","number"),
	CONSTRAINT "revisions_number_positive" CHECK ("revisions"."number" >= 1),
	CONSTRAINT "revisions_sent_has_hash" CHECK ("revisions"."status" = 'draft' OR "revisions"."content_hash" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_revision_line_id_revision_lines_id_fk" FOREIGN KEY ("revision_line_id") REFERENCES "public"."revision_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_lines" ADD CONSTRAINT "revision_lines_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_lines" ADD CONSTRAINT "revision_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_based_on_revision_id_revisions_id_fk" FOREIGN KEY ("based_on_revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;