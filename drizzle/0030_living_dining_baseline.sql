ALTER TABLE "pricing_cases" ADD COLUMN "baseline_quote" jsonb;
--> statement-breakpoint
CREATE FUNCTION pricing_case_baseline_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.baseline_quote IS DISTINCT FROM NEW.baseline_quote THEN
    RAISE EXCEPTION 'a persisted scenario baseline cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pricing_case_baseline_immutable
  BEFORE UPDATE OF baseline_quote ON pricing_cases
  FOR EACH ROW EXECUTE FUNCTION pricing_case_baseline_immutable();
