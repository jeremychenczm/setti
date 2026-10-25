ALTER TABLE "try_seeds" ADD COLUMN "visitor_id" uuid;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "scenario" text DEFAULT 'maple-mixed-change-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "scenario_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "stages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "try_seeds" ADD COLUMN "recoverable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "try_seeds_visitor_id" ON "try_seeds" USING btree ("visitor_id");--> statement-breakpoint
ALTER TABLE "try_seeds" ADD CONSTRAINT "try_seeds_scenario_version_positive" CHECK ("try_seeds"."scenario_version" > 0);--> statement-breakpoint
ALTER TABLE "try_seeds" ADD CONSTRAINT "try_seeds_lease_complete" CHECK (("try_seeds"."lease_id" IS NULL) = ("try_seeds"."lease_expires_at" IS NULL));