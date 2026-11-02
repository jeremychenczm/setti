CREATE TABLE "inbox_reads" (
	"session_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"reminder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "inbox_reads_session_id_account_id_pk" PRIMARY KEY("session_id","account_id")
);
