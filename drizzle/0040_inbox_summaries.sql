CREATE TABLE "inbox_summaries" (
	"key" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sentences" jsonb,
	"model" text,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
