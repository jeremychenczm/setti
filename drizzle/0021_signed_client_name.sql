-- The client signs a change order with her name alone, as on V1: the demo label
-- on the document's client name ("Sofia Martinez (demo client)") is not part of it.
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
     OR NEW.client_name IS DISTINCT FROM regexp_replace(doc.document->>'clientName', '\s*\(demo client\)$', '')
     OR rev.status IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'client decision does not match the waiting frozen document' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
