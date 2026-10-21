CREATE TABLE "change_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"review_version" integer NOT NULL,
	"revision_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"document" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "change_orders_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "change_orders_review_version_unique" UNIQUE("review_id","review_version"),
	CONSTRAINT "change_orders_review_version_positive" CHECK ("change_orders"."review_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_cases" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_revision_id" uuid NOT NULL,
	"baseline_quote_id" text NOT NULL,
	"item_mapping" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_cases_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"source_draft_id" uuid NOT NULL,
	"source_draft_revision" integer NOT NULL,
	"version" integer NOT NULL,
	"input" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_reviews_case_id_unique" UNIQUE("case_id"),
	CONSTRAINT "pricing_reviews_version_positive" CHECK ("pricing_reviews"."version" > 0),
	CONSTRAINT "pricing_reviews_source_revision_positive" CHECK ("pricing_reviews"."source_draft_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "revision_lines" ALTER COLUMN "returnable" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_review_id_pricing_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."pricing_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_cases" ADD CONSTRAINT "pricing_cases_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_cases" ADD CONSTRAINT "pricing_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_cases" ADD CONSTRAINT "pricing_cases_baseline_revision_id_revisions_id_fk" FOREIGN KEY ("baseline_revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_reviews" ADD CONSTRAINT "pricing_reviews_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION change_orders_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'change orders are immutable records and cannot be changed or deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER change_orders_immutable
  BEFORE UPDATE OR DELETE ON change_orders
  FOR EACH ROW EXECUTE FUNCTION change_orders_immutable();
