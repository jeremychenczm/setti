CREATE TABLE "ai_allowances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"used" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_allowances_used_positive" CHECK ("ai_allowances"."used" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_allowances" ADD CONSTRAINT "ai_allowances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;