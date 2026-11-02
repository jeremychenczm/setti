CREATE TABLE "demo_clocks" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"days" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_clocks_days" CHECK ("demo_clocks"."days" BETWEEN 0 AND 30)
);
