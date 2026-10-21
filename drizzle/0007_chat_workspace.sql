CREATE TABLE "chat_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"draft" jsonb,
	"active_message_id" uuid,
	"active_run_id" uuid,
	"active_run_started_at" timestamp with time zone,
	"latest_completed_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_cases_session_project_unique" UNIQUE("session_id","project_key"),
	CONSTRAINT "chat_cases_project_key_valid" CHECK ("chat_cases"."project_key" IN ('willow', 'maple')),
	CONSTRAINT "chat_cases_active_run_complete" CHECK (("chat_cases"."active_message_id" IS NULL AND "chat_cases"."active_run_id" IS NULL AND "chat_cases"."active_run_started_at" IS NULL) OR ("chat_cases"."active_message_id" IS NOT NULL AND "chat_cases"."active_run_id" IS NOT NULL AND "chat_cases"."active_run_started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"case_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"sequence" serial NOT NULL,
	"actor" text NOT NULL,
	"text" text NOT NULL,
	"reply_to_message_id" uuid,
	"ai_state" text DEFAULT 'none' NOT NULL,
	"error" text,
	"model" text,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_case_id_id_pk" PRIMARY KEY("case_id","id"),
	CONSTRAINT "chat_messages_case_reply_unique" UNIQUE("case_id","reply_to_message_id"),
	CONSTRAINT "chat_messages_actor_valid" CHECK ("chat_messages"."actor" IN ('designer', 'client', 'assistant')),
	CONSTRAINT "chat_messages_ai_state_valid" CHECK ("chat_messages"."ai_state" IN ('none', 'running', 'completed', 'failed')),
	CONSTRAINT "chat_messages_text_not_empty" CHECK (length(btrim("chat_messages"."text")) > 0)
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE cascade ON UPDATE no action;