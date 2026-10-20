-- Tracker bookkeeping in the link (merge baseline, comment listing times) is not part of any
-- client record, so writes that change only it mark no change and poke no event stream.
DROP TRIGGER record_change ON issues;
CREATE TRIGGER record_change AFTER INSERT OR DELETE ON issues FOR EACH ROW EXECUTE FUNCTION record_change();
CREATE TRIGGER record_change_update AFTER UPDATE ON issues FOR EACH ROW
    WHEN ((to_jsonb(OLD) - 'tracker') IS DISTINCT FROM (to_jsonb(NEW) - 'tracker')
        OR (OLD.tracker - ARRAY['baseline','comments_at','comments_imported','comments_tried_at'])
            IS DISTINCT FROM (NEW.tracker - ARRAY['baseline','comments_at','comments_imported','comments_tried_at']))
    EXECUTE FUNCTION record_change();
