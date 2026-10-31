CREATE TABLE "studio_threads" (
	"session_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_run_id" uuid,
	"active_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_threads_session_id_project_id_pk" PRIMARY KEY("session_id","project_id"),
	CONSTRAINT "studio_threads_messages_array" CHECK (jsonb_typeof("studio_threads"."messages") = 'array'),
	CONSTRAINT "studio_threads_active_run_complete" CHECK (("studio_threads"."active_run_id" IS NULL) = ("studio_threads"."active_since" IS NULL))
);
