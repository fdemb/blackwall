ALTER TABLE projects
 ADD COLUMN lead_id uuid,
 ADD COLUMN status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')),
 ADD COLUMN health text CHECK(health IN ('on_track','at_risk','off_track')),
 ADD COLUMN start_date date,
 ADD COLUMN target_date date,
 ADD CONSTRAINT projects_dates_ordered CHECK(target_date>=start_date),
 ADD CONSTRAINT projects_lead FOREIGN KEY(workspace_id,lead_id) REFERENCES workspace_members(workspace_id,user_id);

-- Binaries released before project leads remove members without clearing the
-- lead, so the database clears it first and the foreign key never blocks them.
CREATE FUNCTION release_project_lead() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE projects SET lead_id=NULL,version=version+1
  WHERE workspace_id=OLD.workspace_id AND lead_id=OLD.user_id;
 RETURN OLD;
END $$;

CREATE TRIGGER release_project_lead BEFORE DELETE ON workspace_members
 FOR EACH ROW EXECUTE FUNCTION release_project_lead();
