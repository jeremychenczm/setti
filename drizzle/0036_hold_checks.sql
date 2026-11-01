CREATE TABLE "hold_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"session_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"holds" integer DEFAULT 0 NOT NULL,
	"readbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notices" integer DEFAULT 0 NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "hold_checks_counts" CHECK ("hold_checks"."holds" >= 0 AND "hold_checks"."notices" >= 0)
);
