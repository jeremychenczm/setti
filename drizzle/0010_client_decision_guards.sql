CREATE OR REPLACE FUNCTION client_decision_matches_document() RETURNS trigger AS $$
DECLARE
  doc change_orders%ROWTYPE;
  rev revisions%ROWTYPE;
  owner_session uuid;
BEGIN
  SELECT * INTO doc FROM change_orders WHERE id = NEW.order_id;
  SELECT session_id INTO owner_session FROM chat_cases WHERE id = doc.case_id;
  SELECT * INTO rev FROM revisions WHERE id = doc.revision_id FOR SHARE;
  IF NEW.revision_id IS DISTINCT FROM doc.revision_id
     OR NEW.session_id IS DISTINCT FROM owner_session
     OR NEW.content_hash IS DISTINCT FROM doc.content_hash
     OR NEW.revision_content_hash IS DISTINCT FROM rev.content_hash
     OR NEW.revision_content_hash IS DISTINCT FROM doc.document->>'revisionContentHash'
     OR NEW.client_name IS DISTINCT FROM doc.document->>'clientName'
     OR rev.status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'client decision does not match the waiting frozen document' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_decision_matches_document ON change_order_decisions;
--> statement-breakpoint
CREATE TRIGGER client_decision_matches_document
  BEFORE INSERT ON change_order_decisions
  FOR EACH ROW EXECUTE FUNCTION client_decision_matches_document();
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_decisions_append_only ON change_order_decisions;
--> statement-breakpoint
CREATE TRIGGER client_decisions_append_only
  BEFORE UPDATE OR DELETE ON change_order_decisions
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION client_decision_complete() RETURNS trigger AS $$
DECLARE
  state revision_status;
  expected_decision decision;
BEGIN
  SELECT status INTO state FROM revisions WHERE id = NEW.revision_id;
  expected_decision := CASE WHEN NEW.decision = 'approved' THEN 'approved'::decision ELSE 'declined'::decision END;
  IF (NEW.decision = 'approved' AND state NOT IN ('approved', 'superseded'))
     OR (NEW.decision = 'changes_requested' AND state <> 'declined')
     OR NOT EXISTS (SELECT 1 FROM revision_lines WHERE revision_id = NEW.revision_id)
     OR EXISTS (
       SELECT 1 FROM revision_lines l LEFT JOIN approvals a ON a.revision_line_id = l.id
       WHERE l.revision_id = NEW.revision_id AND (
         a.id IS NULL OR a.revision_id IS DISTINCT FROM NEW.revision_id
         OR a.decision IS DISTINCT FROM expected_decision
         OR a.content_hash IS DISTINCT FROM NEW.revision_content_hash
         OR a.signature IS DISTINCT FROM NEW.signature
         OR a.approver_name IS DISTINCT FROM NEW.client_name
       )
     ) THEN
    RAISE EXCEPTION 'whole-document decision requires matching revision status and every line decision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS client_decision_complete ON change_order_decisions;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER client_decision_complete
  AFTER INSERT ON change_order_decisions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION client_decision_complete();
