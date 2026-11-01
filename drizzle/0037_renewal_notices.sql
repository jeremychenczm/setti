CREATE TABLE "renewal_notices" (
	"authorization_id" uuid PRIMARY KEY NOT NULL,
	"case_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "renewal_notices" ADD CONSTRAINT "renewal_notices_authorization_id_paypal_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."paypal_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER renewal_notices_immutable
  BEFORE UPDATE OR DELETE ON renewal_notices
  FOR EACH ROW EXECUTE FUNCTION money_facts_immutable('authorization_id', 'case_id', 'message_id', 'created_at');
