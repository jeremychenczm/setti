-- Quote rules enforced by the database:
--   1. Lines change only while their revision is a draft.
--   2. A sent revision keeps its content; its status only moves forward.
--   3. An approval must match the frozen content of a sent revision, and is never edited.

CREATE OR REPLACE FUNCTION revision_lines_only_in_draft() RETURNS trigger AS $$
DECLARE
  rev_id uuid;
  rev_status revision_status;
BEGIN
  FOREACH rev_id IN ARRAY ARRAY[OLD.revision_id, NEW.revision_id] LOOP
    CONTINUE WHEN rev_id IS NULL;
    -- FOR SHARE waits for a concurrent send to finish, so a line cannot slip in after hashing.
    SELECT status INTO rev_status FROM revisions WHERE id = rev_id FOR SHARE;
    IF rev_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'revision % is frozen: its lines cannot change after it is sent', rev_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER revision_lines_only_in_draft
  BEFORE INSERT OR UPDATE OR DELETE ON revision_lines
  FOR EACH ROW EXECUTE FUNCTION revision_lines_only_in_draft();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION revisions_freeze() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'revision % was sent and cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' AND (
       NEW.project_id <> OLD.project_id
    OR NEW.number <> OLD.number
    OR NEW.based_on_revision_id IS DISTINCT FROM OLD.based_on_revision_id
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
  ) THEN
    RAISE EXCEPTION 'revision % is frozen: its content cannot change after it is sent', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'sent')
    OR (OLD.status = 'sent' AND NEW.status IN ('approved', 'declined', 'superseded'))
    OR (OLD.status = 'approved' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'revision % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER revisions_freeze
  BEFORE UPDATE OR DELETE ON revisions
  FOR EACH ROW EXECUTE FUNCTION revisions_freeze();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION approvals_match_revision() RETURNS trigger AS $$
DECLARE
  rev revisions%ROWTYPE;
  line_revision uuid;
BEGIN
  SELECT revision_id INTO line_revision FROM revision_lines WHERE id = NEW.revision_line_id;
  IF line_revision IS DISTINCT FROM NEW.revision_id THEN
    RAISE EXCEPTION 'line % does not belong to revision %', NEW.revision_line_id, NEW.revision_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO rev FROM revisions WHERE id = NEW.revision_id FOR SHARE;
  IF rev.status <> 'sent' THEN
    RAISE EXCEPTION 'revision % is %, not waiting for approval', rev.id, rev.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.content_hash IS DISTINCT FROM rev.content_hash THEN
    RAISE EXCEPTION 'approval does not match the content of revision %', rev.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approvals_match_revision
  BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_match_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION approvals_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approvals are a record and cannot be changed or deleted' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER approvals_append_only
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_append_only();
