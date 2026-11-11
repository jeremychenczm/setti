CREATE TABLE "project_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_clients_one_per_user" UNIQUE("case_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "studios" ADD COLUMN "kind" text DEFAULT 'real' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "demo_persona" text;--> statement-breakpoint
ALTER TABLE "project_clients" ADD CONSTRAINT "project_clients_case_id_chat_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chat_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_clients" ADD CONSTRAINT "project_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studios" ADD CONSTRAINT "studios_kind_valid" CHECK ("studios"."kind" IN ('real', 'demo'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_demo_persona_valid" CHECK ("users"."demo_persona" IS NULL OR "users"."demo_persona" IN ('jordan', 'emma'));