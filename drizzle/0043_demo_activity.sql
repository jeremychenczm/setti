CREATE TABLE "demo_activity" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "demo_activity_end" CHECK (("demo_activity"."ended_at" IS NULL) = ("demo_activity"."end_reason" IS NULL) AND ("demo_activity"."end_reason" IS NULL OR "demo_activity"."end_reason" IN ('idle', 'visitor')))
);
--> statement-breakpoint
ALTER TABLE "item_cancellations" DROP CONSTRAINT "item_cancellations_reason";--> statement-breakpoint
ALTER TABLE "hold_checks" ADD COLUMN "ended_demos" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_activity_last_active_at" ON "demo_activity" USING btree ("last_active_at");--> statement-breakpoint
ALTER TABLE "item_cancellations" ADD CONSTRAINT "item_cancellations_reason" CHECK ("item_cancellations"."reason" IN ('unavailable', 'no_response', 'client_asked', 'other', 'demo_ended'));--> statement-breakpoint
-- Demos that already exist get a full week from this migration before the daily check can end them.
INSERT INTO "demo_activity" ("session_id", "last_active_at") SELECT DISTINCT "session_id", now() FROM "chat_cases" ON CONFLICT DO NOTHING;
