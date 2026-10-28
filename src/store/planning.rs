use super::*;

impl Operation<'_> {
    pub(super) async fn planning(&mut self, command: Command) -> Result<Option<Uuid>> {
        let id = match command {
            Command::CreateTeam {
                id,
                name,
                key,
                members,
                default_stage_ids,
            } => {
                self.create_team(id, name, key, members, default_stage_ids)
                    .await?
            }
            Command::SetTeamMembers { id, members } => {
                self.set_team_members(id, members).await?;
                id
            }
            Command::SetTeamArchive {
                id,
                archive_after_days,
            } => {
                self.set_team_archive(id, archive_after_days).await?;
                id
            }
            Command::SetTeamAppearance { id, icon, color } => {
                self.set_team_appearance(id, icon, color).await?;
                id
            }
            Command::UpdateTeam { id, name, key } => {
                self.update_team(id, name, key).await?;
                id
            }
            Command::DeleteTeam { id } => {
                self.delete_team(id).await?;
                id
            }
            Command::CreateStage {
                id,
                team_id,
                name,
                kind,
                position,
            } => self.create_stage(id, team_id, name, kind, position).await?,
            Command::UpdateStage {
                team_id,
                id,
                name,
                kind,
                position,
            } => {
                self.update_stage(team_id, id, name, kind, position).await?;
                id
            }
            Command::DeleteStage {
                team_id,
                id,
                replacement,
            } => {
                self.delete_stage(team_id, id, replacement).await?;
                id
            }
            Command::CreateLabel { id, name, color } => self.create_label(id, name, color).await?,
            Command::UpdateLabel { id, name, color } => {
                self.update_label(id, name, color).await?;
                id
            }
            Command::DeleteLabel { id } => {
                self.delete_label(id).await?;
                id
            }
            Command::CreateProject {
                id,
                name,
                description,
                team_ids,
            } => self.create_project(id, name, description, team_ids).await?,
            Command::UpdateProject {
                id,
                name,
                description,
                team_ids,
            } => {
                self.update_project(id, name, description, team_ids).await?;
                id
            }
            Command::SetProjectPlan {
                id,
                lead_id,
                status,
                health,
                start_date,
                target_date,
            } => {
                self.set_project_plan(id, lead_id, status, health, start_date, target_date)
                    .await?;
                id
            }
            Command::DeleteProject { id } => {
                self.delete_project(id).await?;
                id
            }
            Command::CreateMilestone {
                id,
                project_id,
                name,
                deadline,
            } => {
                self.create_milestone(id, project_id, name, deadline)
                    .await?
            }
            Command::UpdateMilestone { id, name, deadline } => {
                self.update_milestone(id, name, deadline).await?;
                id
            }
            Command::DeleteMilestone { id } => {
                self.delete_milestone(id).await?;
                id
            }
            Command::CreateSprint {
                id,
                team_id,
                name,
                goal,
                starts_at,
                ends_at,
            } => {
                self.create_sprint(id, team_id, name, goal, starts_at, ends_at)
                    .await?
            }
            Command::UpdateSprint {
                id,
                name,
                goal,
                starts_at,
                ends_at,
                state,
            } => {
                self.update_sprint(id, name, goal, starts_at, ends_at, state)
                    .await?;
                id
            }
            Command::CompleteSprint {
                id,
                carryover_sprint_id,
            } => {
                self.complete_sprint(id, carryover_sprint_id).await?;
                id
            }
            Command::ArchiveSprint { id } => {
                self.archive_sprint(id).await?;
                id
            }
            _ => {
                return Err(Error::Internal(
                    "command sent to wrong feature operation".into(),
                ));
            }
        };

        Ok(Some(id))
    }

    async fn create_team(
        &mut self,
        id: Option<Uuid>,
        name: String,
        key: String,
        members: Vec<Uuid>,
        default_stage_ids: Option<Vec<Uuid>>,
    ) -> Result<Uuid> {
        self.admin()?;
        text(&name, 200)?;
        crate::domain::validate_team_key(&key)?;
        self.capacity(Resource::Teams, 1).await?;
        let members = sorted_unique(members);
        for user in &members {
            self.member(*user).await?;
        }

        if default_stage_ids
            .as_ref()
            .is_some_and(|ids| ids.len() != crate::domain::default_stages().len())
        {
            return Err(Error::BadRequest(
                "default_stage_ids must contain exactly 4 ids".into(),
            ));
        }
        // Reserve the team id together with the stage ids in one
        // batch call, so a collision on any of them is a 409.
        let mut provided = vec![id];
        provided.extend(default_stage_ids.iter().flatten().map(|stage| Some(*stage)));
        let resolved = self.reserve_client_ids(&provided).await?;
        let unique: std::collections::BTreeSet<_> = resolved.iter().collect();
        if unique.len() != resolved.len() {
            return Err(Error::Conflict("id already exists".into()));
        }
        let team_id = resolved[0];

        let taken: Vec<String> = sqlx::query_scalar!(
            "SELECT color FROM teams WHERE workspace_id=$1",
            self.workspace_id,
        )
        .fetch_all(&mut *self.tx)
        .await?;
        let color = crate::domain::least_used_team_color(taken.iter().map(String::as_str));
        sqlx::query!(
            "INSERT INTO teams(id,workspace_id,name,key,archive_after_days,icon,color) VALUES($1,$2,$3,$4,30,$5,$6)",
            team_id,
            self.workspace_id,
            name,
            key,
            crate::domain::TEAM_ICONS[0],
            color,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(team_conflict)?;
        self.created("teams", team_id);
        self.insert_team_members(team_id, members).await?;

        let mut supplied = default_stage_ids.map(Vec::into_iter);
        for (position, (name, kind)) in crate::domain::default_stages().into_iter().enumerate() {
            let stage_id = supplied.as_mut().map_or_else(Uuid::new_v4, |ids| {
                ids.next()
                    .expect("reserved exactly one id per default stage")
            });
            self.insert_stage(stage_id, team_id, name, &kind, position as i64)
                .await?;
            self.created("stages", stage_id);
        }

        Ok(team_id)
    }

    async fn insert_team_members(&mut self, team_id: Uuid, members: Vec<Uuid>) -> Result<()> {
        for user in members {
            sqlx::query!(
                "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
                self.workspace_id,
                team_id,
                user,
            )
            .execute(&mut *self.tx)
            .await?;
        }
        Ok(())
    }

    async fn insert_stage(
        &mut self,
        id: Uuid,
        team_id: Uuid,
        name: &str,
        kind: &StageKind,
        position: i64,
    ) -> Result<()> {
        sqlx::query!("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,$4,$5,$6)", id, self.workspace_id, team_id, name, enum_text(kind), position)
            .execute(&mut *self.tx)
            .await
            .map_err(id_conflict)?;
        Ok(())
    }

    async fn set_team_members(&mut self, id: Uuid, members: Vec<Uuid>) -> Result<()> {
        self.admin()?;
        let members = sorted_unique(members);
        for user in &members {
            self.member(*user).await?;
        }

        self.touch("teams", id).await?;
        sqlx::query!(
            "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        self.insert_team_members(id, members).await
    }

    async fn set_team_archive(&mut self, id: Uuid, archive_after_days: Option<u32>) -> Result<()> {
        self.admin()?;
        crate::domain::validate_archive_days(archive_after_days)?;
        self.touch("teams", id).await?;
        sqlx::query!(
            "UPDATE teams SET archive_after_days=$3::bigint WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            archive_after_days.map(i64::from),
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn set_team_appearance(&mut self, id: Uuid, icon: String, color: String) -> Result<()> {
        self.admin()?;
        crate::domain::validate_team_appearance(&icon, &color)?;
        self.touch("teams", id).await?;
        sqlx::query!(
            "UPDATE teams SET icon=$3,color=$4 WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            icon,
            color,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn update_team(&mut self, id: Uuid, name: String, key: String) -> Result<()> {
        self.admin()?;
        text(&name, 200)?;
        crate::domain::validate_team_key(&key)?;
        self.touch("teams", id).await?;
        // The `claim_team_key` trigger keeps the old key as a former key.
        sqlx::query!(
            "UPDATE teams SET name=$3,key=$4 WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            name,
            key,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(team_conflict)?;
        Ok(())
    }

    async fn delete_team(&mut self, id: Uuid) -> Result<()> {
        self.admin()?;
        // Tracker pages lock the issue graph before their connection.
        self.lock_graph().await?;
        // Creating or moving an issue into the team locks it, so the emptiness
        // check below holds until commit.
        self.lock("teams", id).await?;
        let has_issues: bool = sqlx::query_scalar!(
            "SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND team_id=$2) AS \"exists!\"",
            self.workspace_id,
            id,
        )
        .fetch_one(&mut *self.tx)
        .await?;
        if has_issues {
            return Err(Error::Conflict(
                "team still has issues, including archived or trashed ones; restore or unarchive them and move them to another team, or wait for the trash to be emptied".into(),
            ));
        }
        let tracked: bool = sqlx::query_scalar!(
            "SELECT EXISTS(SELECT 1 FROM tracker_connections c, jsonb_array_elements(c.projects) mapping \
             WHERE c.workspace_id=$1 AND NOT c.deleted AND mapping->>'team_id'=$2) AS \"exists!\"",
            self.workspace_id,
            id.to_string(),
        )
        .fetch_one(&mut *self.tx)
        .await?;
        if tracked {
            return Err(Error::Conflict(
                "an issue tracker imports into this team; remove that mapping first".into(),
            ));
        }

        // Issues moved out of the team lose the keys they had in it.
        self.touch_referencing_issues(
            "SELECT DISTINCT issue_id FROM issue_key_aliases WHERE workspace_id=$1 AND team_id=$2 ORDER BY issue_id",
            id,
        )
        .await?;
        let projects: Vec<Uuid> = sqlx::query_scalar!(
            "SELECT project_id FROM project_teams WHERE workspace_id=$1 AND team_id=$2 ORDER BY project_id",
            self.workspace_id,
            id,
        )
        .fetch_all(&mut *self.tx)
        .await?;
        for project in projects {
            self.touch("projects", project).await?;
        }
        for sql in [
            "DELETE FROM project_teams WHERE workspace_id=$1 AND team_id=$2",
            "DELETE FROM sprint_outcomes WHERE workspace_id=$1 AND sprint_id IN (SELECT id FROM sprints WHERE workspace_id=$1 AND team_id=$2)",
            "DELETE FROM sprints WHERE workspace_id=$1 AND team_id=$2",
            "DELETE FROM stages WHERE workspace_id=$1 AND team_id=$2",
            "DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2",
            "DELETE FROM teams WHERE workspace_id=$1 AND id=$2",
        ] {
            sqlx::query(sql)
                .bind(self.workspace_id)
                .bind(id)
                .execute(&mut *self.tx)
                .await?;
        }
        Ok(())
    }

    async fn create_stage(
        &mut self,
        id: Option<Uuid>,
        team_id: Uuid,
        name: String,
        kind: StageKind,
        position: i64,
    ) -> Result<Uuid> {
        self.admin()?;
        text(&name, 200)?;
        self.lock_team(team_id, true).await?;
        let count: i64 = sqlx::query_scalar!(
            "SELECT count(*) AS \"count!\" FROM stages WHERE workspace_id=$1 AND team_id=$2",
            self.workspace_id,
            team_id,
        )
        .fetch_one(&mut *self.tx)
        .await?;
        if count >= 100 {
            return Err(Error::BadRequest(
                "team must contain 1 to 100 stages".into(),
            ));
        }

        let id = self.reserve_client_id(id).await?;
        self.insert_stage(id, team_id, &name, &kind, position)
            .await?;
        self.created("stages", id);
        Ok(id)
    }

    async fn update_stage(
        &mut self,
        team_id: Uuid,
        id: Uuid,
        name: String,
        kind: StageKind,
        position: i64,
    ) -> Result<()> {
        self.admin()?;
        text(&name, 200)?;
        self.lock_graph().await?;
        self.lock_team(team_id, false).await?;
        let previous: String = sqlx::query_scalar!(
            "SELECT kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3 FOR UPDATE",
            self.workspace_id,
            team_id,
            id,
        )
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;

        self.touch("stages", id).await?;
        let next = enum_text(&kind);
        let kind_changed = previous != next;
        let issues = if kind_changed {
            self.stage_issues(id).await?
        } else {
            vec![]
        };

        sqlx::query!("UPDATE stages SET name=$4,kind=$5,position=$6 WHERE workspace_id=$1 AND team_id=$2 AND id=$3", self.workspace_id, team_id, id, name, &next, position)
            .execute(&mut *self.tx)
            .await?;

        if kind_changed {
            self.after_stage_kind_change(id, issues, &previous, &next)
                .await?;
        }
        Ok(())
    }

    async fn delete_stage(&mut self, team_id: Uuid, id: Uuid, replacement: Uuid) -> Result<()> {
        self.admin()?;
        if id == replacement {
            return Err(Error::BadRequest("invalid replacement stage".into()));
        }

        // Tracker pages lock the issue graph before their connection.
        self.lock_graph().await?;
        let mappings = self.lock_stage_mappings(id).await?;
        self.lock_team(team_id, true).await?;
        let stages = sqlx::query!("SELECT id,kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=ANY($3) ORDER BY id FOR UPDATE", self.workspace_id, team_id, &[id, replacement][..])
            .fetch_all(&mut *self.tx)
            .await?;
        if stages.len() != 2 {
            return Err(Error::BadRequest("invalid replacement stage".into()));
        }
        let kind_of = |stage: Uuid| -> String {
            stages
                .iter()
                .find(|row| row.id == stage)
                .expect("both stages were locked")
                .kind
                .clone()
        };
        let (previous, next) = (kind_of(id), kind_of(replacement));

        self.touch("stages", id).await?;
        let issues = self.stage_issues(id).await?;
        for (issue_id, _) in &issues {
            self.touch("issues", *issue_id).await?;
        }
        let synced = self.synced_stage_issues(id).await?;
        self.move_stage_issues(id, replacement).await?;
        self.replace_stage_mappings(mappings, id, replacement)
            .await?;
        // The move skips `issue_effects`, so queue the status pushes it would. After the
        // mapping rewrite, which cancels pending tracker jobs, so the wake-up survives.
        for before in synced {
            let after = Issue {
                stage_id: replacement,
                ..before.clone()
            };
            crate::tracker::enqueue_fields(&mut self.tx, self.workspace_id, &before, &after)
                .await?;
        }
        sqlx::query!(
            "DELETE FROM stages WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;

        self.after_stage_kind_change(replacement, issues, &previous, &next)
            .await
    }

    /// Live tracker-linked issues in the stage, read before it is replaced.
    async fn synced_stage_issues(&mut self, stage_id: Uuid) -> Result<Vec<Issue>> {
        let ids: Vec<Uuid> = sqlx::query_scalar!("SELECT id FROM issues WHERE workspace_id=$1 AND stage_id=$2 AND tracker IS NOT NULL AND deleted_at IS NULL ORDER BY id", self.workspace_id, stage_id)
            .fetch_all(&mut *self.tx)
            .await?;
        let mut issues = Vec::with_capacity(ids.len());
        for id in ids {
            issues.push(reads::issue_on(&mut self.tx, self.workspace_id, id, false).await?);
        }
        Ok(issues)
    }

    async fn move_stage_issues(&mut self, id: Uuid, replacement: Uuid) -> Result<()> {
        sqlx::query!(
            "UPDATE issues SET stage_id=$3,updated_at=now() WHERE workspace_id=$1 AND stage_id=$2",
            self.workspace_id,
            id,
            replacement,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Issues in `stage` moved from kind `previous` to `next`: keep the
    /// Done-entry clock for auto-archive (Done only, not cancelled), take
    /// backlog work out of sprints, reschedule reminders and record newly
    /// completed issues.
    async fn after_stage_kind_change(
        &mut self,
        stage: Uuid,
        issues: Vec<(Uuid, bool)>,
        previous: &str,
        next: &str,
    ) -> Result<()> {
        if next == "done" {
            sqlx::query!("UPDATE issues SET done_at=COALESCE(done_at,now()),updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL AND done_at IS NULL", self.workspace_id, stage)
                .execute(&mut *self.tx)
                .await?;
        } else if previous == "done" {
            sqlx::query!("UPDATE issues SET done_at=NULL,updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL", self.workspace_id, stage)
                .execute(&mut *self.tx)
                .await?;
        }
        if next == "backlog" {
            self.leave_sprints(stage).await?;
        }

        let completes = !terminal(previous) && terminal(next);
        for (issue_id, deleted) in issues {
            self.schedule_reminder(issue_id).await?;
            if completes && !deleted {
                self.activity("issue_completed", Some(issue_id), vec![])
                    .await?;
            }
        }
        Ok(())
    }

    async fn create_label(
        &mut self,
        id: Option<Uuid>,
        name: String,
        color: String,
    ) -> Result<Uuid> {
        validate_label(&name, &color)?;
        self.capacity(Resource::Labels, 1).await?;
        let id = self.reserve_client_id(id).await?;
        sqlx::query!(
            "INSERT INTO labels(id,workspace_id,name,color) VALUES($1,$2,$3,$4)",
            id,
            self.workspace_id,
            name,
            color,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(id_conflict)?;
        self.created("labels", id);
        Ok(id)
    }

    async fn update_label(&mut self, id: Uuid, name: String, color: String) -> Result<()> {
        validate_label(&name, &color)?;
        self.touch("labels", id).await?;
        sqlx::query!(
            "UPDATE labels SET name=$3,color=$4 WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            name,
            color,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn delete_label(&mut self, id: Uuid) -> Result<()> {
        self.lock_graph().await?;
        self.touch("labels", id).await?;
        self.touch_referencing_issues("SELECT i.id FROM issues i JOIN issue_labels l ON l.issue_id=i.id WHERE i.workspace_id=$1 AND l.label_id=$2 ORDER BY i.id FOR UPDATE OF i", id)
            .await?;
        sqlx::query!(
            "DELETE FROM issue_labels WHERE workspace_id=$1 AND label_id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        self.delete_planning_row("labels", id).await
    }

    async fn touch_referencing_issues(&mut self, select: &str, id: Uuid) -> Result<()> {
        let issues: Vec<Uuid> = sqlx::query_scalar(select)
            .bind(self.workspace_id)
            .bind(id)
            .fetch_all(&mut *self.tx)
            .await?;
        for issue in &issues {
            self.touch("issues", *issue).await?;
        }
        sqlx::query!(
            "UPDATE issues SET updated_at=now() WHERE workspace_id=$1 AND id=ANY($2)",
            self.workspace_id,
            &issues,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn delete_planning_row(&mut self, table: &str, id: Uuid) -> Result<()> {
        assert!(matches!(table, "labels" | "projects" | "milestones"));
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE workspace_id=$1 AND id=$2"
        ))
        .bind(self.workspace_id)
        .bind(id)
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Sorts and dedupes the teams and locks each one for the project write.
    async fn lock_project_teams(&mut self, team_ids: Vec<Uuid>) -> Result<Vec<Uuid>> {
        let team_ids = sorted_unique(team_ids);
        for team in &team_ids {
            self.lock_team(*team, false).await?;
        }
        Ok(team_ids)
    }

    async fn create_project(
        &mut self,
        id: Option<Uuid>,
        name: String,
        description: String,
        team_ids: Vec<Uuid>,
    ) -> Result<Uuid> {
        validate_project(&name, &description)?;
        self.capacity(Resource::Projects, 1).await?;
        let team_ids = self.lock_project_teams(team_ids).await?;

        let id = self.reserve_client_id(id).await?;
        sqlx::query!(
            "INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,$4)",
            id,
            self.workspace_id,
            name,
            description,
        )
        .execute(&mut *self.tx)
        .await
        .map_err(id_conflict)?;

        self.replace_project_teams(id, team_ids).await?;
        self.created("projects", id);
        Ok(id)
    }

    async fn update_project(
        &mut self,
        id: Uuid,
        name: String,
        description: String,
        team_ids: Vec<Uuid>,
    ) -> Result<()> {
        validate_project(&name, &description)?;
        let team_ids = self.lock_project_teams(team_ids).await?;

        self.touch("projects", id).await?;
        let has_issues: bool = sqlx::query_scalar!("SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND project_id=$2 AND NOT(team_id=ANY($3))) AS \"exists!\"", self.workspace_id, id, &team_ids)
            .fetch_one(&mut *self.tx)
            .await?;
        if has_issues {
            return Err(Error::Conflict("project teams still contain issues".into()));
        }

        sqlx::query!(
            "UPDATE projects SET name=$3,description=$4 WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            name,
            description,
        )
        .execute(&mut *self.tx)
        .await?;
        self.replace_project_teams(id, team_ids).await
    }

    async fn set_project_plan(
        &mut self,
        id: Uuid,
        lead_id: Option<Uuid>,
        status: ProjectStatus,
        health: Option<ProjectHealth>,
        start_date: Option<chrono::NaiveDate>,
        target_date: Option<chrono::NaiveDate>,
    ) -> Result<()> {
        crate::domain::validate_project_dates(start_date, target_date)?;
        if let Some(lead) = lead_id {
            self.member(lead).await?;
        }
        self.touch("projects", id).await?;
        sqlx::query!("UPDATE projects SET lead_id=$3,status=$4,health=$5,start_date=$6,target_date=$7 WHERE workspace_id=$1 AND id=$2", self.workspace_id, id, lead_id, enum_text(&status), health.as_ref().map(enum_text), start_date, target_date)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    async fn delete_project(&mut self, id: Uuid) -> Result<()> {
        self.lock_graph().await?;
        self.touch("projects", id).await?;
        self.touch_referencing_issues(
            "SELECT id FROM issues WHERE workspace_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",
            id,
        )
        .await?;
        sqlx::query!("UPDATE issues SET project_id=NULL,milestone_id=NULL WHERE workspace_id=$1 AND project_id=$2", self.workspace_id, id)
            .execute(&mut *self.tx)
            .await?;
        sqlx::query!(
            "DELETE FROM milestones WHERE workspace_id=$1 AND project_id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        sqlx::query!(
            "DELETE FROM project_teams WHERE workspace_id=$1 AND project_id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        self.delete_planning_row("projects", id).await
    }

    async fn create_milestone(
        &mut self,
        id: Option<Uuid>,
        project_id: Uuid,
        name: String,
        deadline: Option<DateTime<Utc>>,
    ) -> Result<Uuid> {
        text(&name, 200)?;
        crate::domain::optional_timestamp(deadline)?;
        self.capacity(Resource::Milestones, 1).await?;
        sqlx::query!(
            "SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            self.workspace_id,
            project_id,
        )
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;

        let id = self.reserve_client_id(id).await?;
        sqlx::query!("INSERT INTO milestones(id,workspace_id,project_id,name,deadline) VALUES($1,$2,$3,$4,$5)", id, self.workspace_id, project_id, name, deadline)
            .execute(&mut *self.tx)
            .await
            .map_err(id_conflict)?;
        self.created("milestones", id);
        Ok(id)
    }

    async fn update_milestone(
        &mut self,
        id: Uuid,
        name: String,
        deadline: Option<DateTime<Utc>>,
    ) -> Result<()> {
        text(&name, 200)?;
        crate::domain::optional_timestamp(deadline)?;
        self.touch("milestones", id).await?;
        sqlx::query!(
            "UPDATE milestones SET name=$3,deadline=$4 WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
            name,
            deadline,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn delete_milestone(&mut self, id: Uuid) -> Result<()> {
        self.lock_graph().await?;
        self.touch("milestones", id).await?;
        self.touch_referencing_issues("SELECT id FROM issues WHERE workspace_id=$1 AND milestone_id=$2 ORDER BY id FOR UPDATE", id)
            .await?;
        sqlx::query!(
            "UPDATE issues SET milestone_id=NULL WHERE workspace_id=$1 AND milestone_id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        self.delete_planning_row("milestones", id).await
    }

    async fn create_sprint(
        &mut self,
        id: Option<Uuid>,
        team_id: Uuid,
        name: String,
        goal: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
    ) -> Result<Uuid> {
        validate_sprint(&name, &goal, starts_at, ends_at)?;
        self.capacity(Resource::Sprints, 1).await?;
        persistence::lock_team_numbers(&mut self.tx, self.workspace_id, team_id).await?;
        let id = self.reserve_client_id(id).await?;
        sqlx::query!("INSERT INTO sprints(id,workspace_id,team_id,number,name,goal,starts_at,ends_at,state) VALUES($1,$2,$3,(SELECT COALESCE(max(number),0)+1 FROM sprints WHERE workspace_id=$2 AND team_id=$3),$4,$5,$6,$7,'planned')", id, self.workspace_id, team_id, name, goal, starts_at, ends_at)
            .execute(&mut *self.tx)
            .await
            .map_err(id_conflict)?;
        self.created("sprints", id);
        Ok(id)
    }

    async fn update_sprint(
        &mut self,
        id: Uuid,
        name: String,
        goal: String,
        starts_at: DateTime<Utc>,
        ends_at: DateTime<Utc>,
        state: SprintState,
    ) -> Result<()> {
        validate_sprint(&name, &goal, starts_at, ends_at)?;
        if state.is_finished() {
            return Err(Error::BadRequest(
                "use completion or archive command".into(),
            ));
        }

        self.touch("sprints", id).await?;
        if terminal_sprint(&self.sprint_state(id).await?) {
            return Err(Error::Conflict("sprint already completed".into()));
        }

        sqlx::query!("UPDATE sprints SET name=$3,goal=$4,starts_at=$5,ends_at=$6,state=$7 WHERE workspace_id=$1 AND id=$2", self.workspace_id, id, name, goal, starts_at, ends_at, enum_text(&state))
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    async fn archive_sprint(&mut self, id: Uuid) -> Result<()> {
        self.touch("sprints", id).await?;
        if !terminal_sprint(&self.sprint_state(id).await?) {
            return Err(Error::BadRequest("complete sprint before archiving".into()));
        }

        sqlx::query!(
            "UPDATE sprints SET state='archived' WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn sprint_state(&mut self, id: Uuid) -> Result<String> {
        Ok(sqlx::query_scalar!(
            "SELECT state FROM sprints WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
        )
        .fetch_one(&mut *self.tx)
        .await?)
    }

    async fn lock_team(&mut self, id: Uuid, exclusive: bool) -> Result<()> {
        let found = if exclusive {
            sqlx::query_scalar!(
                "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
                self.workspace_id,
                id,
            )
            .fetch_optional(&mut *self.tx)
            .await?
        } else {
            sqlx::query_scalar!(
                "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 FOR SHARE",
                self.workspace_id,
                id,
            )
            .fetch_optional(&mut *self.tx)
            .await?
        };
        found.ok_or(Error::NotFound)?;

        Ok(())
    }

    async fn lock_stage_mappings(
        &mut self,
        stage: Uuid,
    ) -> Result<Vec<(Uuid, Vec<crate::tracker::Mapping>)>> {
        let rows = sqlx::query!("SELECT id,projects FROM tracker_connections WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(projects) mapping, jsonb_each_text(COALESCE(mapping->'stage_mapping','{}'::jsonb)) entry WHERE entry.value=$2) ORDER BY id FOR NO KEY UPDATE", self.workspace_id, stage.to_string())
            .fetch_all(&mut *self.tx).await?;
        rows.into_iter()
            .map(|row| Ok((row.id, serde_json::from_value(row.projects)?)))
            .collect()
    }

    async fn replace_stage_mappings(
        &mut self,
        mappings: Vec<(Uuid, Vec<crate::tracker::Mapping>)>,
        previous: Uuid,
        replacement: Uuid,
    ) -> Result<()> {
        for (connection, mut projects) in mappings {
            for project in &mut projects {
                for stage in project.stage_mapping.values_mut() {
                    if *stage == previous {
                        *stage = replacement;
                    }
                }
            }
            // Fence pages fetched with the previous mapping; the pagination cursor remains valid.
            sqlx::query!("UPDATE tracker_connections SET projects=$3,generation=generation+1,next_run_at=clock_timestamp(),status='pending',last_error='',push_error=NULL WHERE workspace_id=$1 AND id=$2", self.workspace_id, connection, serde_json::to_value(projects)?)
                .execute(&mut *self.tx).await?;
            sqlx::query!("UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue='tracker' AND state='pending' AND payload->>'connection_id'=$1", connection.to_string())
                .execute(&mut *self.tx).await?;
        }
        Ok(())
    }

    /// Clears the sprint of every issue in a backlog stage.
    async fn leave_sprints(&mut self, stage: Uuid) -> Result<()> {
        let ids: Vec<Uuid> = sqlx::query_scalar!("SELECT id FROM issues WHERE workspace_id=$1 AND stage_id=$2 AND sprint_id IS NOT NULL ORDER BY id", self.workspace_id, stage)
            .fetch_all(&mut *self.tx)
            .await?;
        for id in &ids {
            self.touch("issues", *id).await?;
        }
        sqlx::query!("UPDATE issues SET sprint_id=NULL,updated_at=now() WHERE workspace_id=$1 AND id=ANY($2)", self.workspace_id, &ids)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    async fn stage_issues(&mut self, stage_id: Uuid) -> Result<Vec<(Uuid, bool)>> {
        let rows = sqlx::query!("SELECT id,deleted_at IS NOT NULL AS \"deleted!\" FROM issues WHERE workspace_id=$1 AND stage_id=$2 ORDER BY id FOR UPDATE", self.workspace_id, stage_id)
            .fetch_all(&mut *self.tx)
            .await?;

        Ok(rows.into_iter().map(|row| (row.id, row.deleted)).collect())
    }

    async fn replace_project_teams(&mut self, project_id: Uuid, team_ids: Vec<Uuid>) -> Result<()> {
        sqlx::query!("DELETE FROM project_teams WHERE workspace_id=$1 AND project_id=$2 AND NOT(team_id=ANY($3))", self.workspace_id, project_id, &team_ids)
            .execute(&mut *self.tx)
            .await?;

        for team_id in team_ids {
            sqlx::query!("INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", self.workspace_id, project_id, team_id)
                .execute(&mut *self.tx)
                .await?;
        }

        Ok(())
    }

    async fn complete_sprint(&mut self, id: Uuid, carryover: Option<Uuid>) -> Result<()> {
        self.lock_graph().await?;
        let mut sprint_ids = vec![id];
        if let Some(target) = carryover {
            sprint_ids.push(target);
        }

        sprint_ids.sort_unstable();
        sprint_ids.dedup();
        let sprints = sqlx::query!("SELECT id,team_id,state FROM sprints WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE", self.workspace_id, &sprint_ids)
            .fetch_all(&mut *self.tx)
            .await?;

        let sprint = sprints
            .iter()
            .find(|row| row.id == id)
            .ok_or(Error::NotFound)?;

        let state = &sprint.state;
        if state == "archived" {
            return Err(Error::Conflict("sprint archived".into()));
        }

        self.touch("sprints", id).await?;
        if state == "completed" {
            return Ok(());
        }

        if let Some(target) = carryover {
            let target_row = sprints
                .iter()
                .find(|row| row.id == target)
                .ok_or(Error::NotFound)?;

            if target == id
                || target_row.team_id != sprint.team_id
                || terminal_sprint(&target_row.state)
            {
                return Err(Error::BadRequest("invalid carryover sprint".into()));
            }
        }

        self.record_sprint_outcome(id, carryover).await?;
        sqlx::query!(
            "UPDATE sprints SET state='completed' WHERE workspace_id=$1 AND id=$2",
            self.workspace_id,
            id,
        )
        .execute(&mut *self.tx)
        .await?;

        Ok(())
    }

    /// Moves the sprint's open issues to `carryover` and stores how much of it got done.
    async fn record_sprint_outcome(&mut self, id: Uuid, carryover: Option<Uuid>) -> Result<()> {
        let rows = sqlx::query!("SELECT i.id,i.estimate,s.kind FROM issues i JOIN stages s ON s.id=i.stage_id AND s.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND i.sprint_id=$2 AND i.deleted_at IS NULL ORDER BY i.id FOR UPDATE OF i", self.workspace_id, id)
            .fetch_all(&mut *self.tx)
            .await?;

        let mut completed = 0_i64;
        let mut effort = 0_i64;
        for row in &rows {
            let issue_id = row.id;
            self.touch("issues", issue_id).await?;
            effort += row.estimate.unwrap_or(0);
            if terminal(&row.kind) {
                completed += 1;
            } else {
                sqlx::query!("UPDATE issues SET sprint_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", self.workspace_id, issue_id, carryover)
                    .execute(&mut *self.tx)
                    .await?;
            }
        }

        sqlx::query!("INSERT INTO sprint_outcomes(workspace_id,sprint_id,total,completed,effort) VALUES($1,$2,$3,$4,$5)", self.workspace_id, id, rows.len() as i64, completed, effort)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

fn sorted_unique(mut ids: Vec<Uuid>) -> Vec<Uuid> {
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn terminal(kind: &str) -> bool {
    matches!(kind, "done" | "cancelled")
}

fn terminal_sprint(state: &str) -> bool {
    matches!(state, "completed" | "archived")
}

fn validate_label(name: &str, color: &str) -> Result<()> {
    text(name, 100)?;
    if color.len() > 40 {
        return Err(Error::BadRequest("invalid color".into()));
    }

    Ok(())
}

fn validate_project(name: &str, description: &str) -> Result<()> {
    text(name, 200)?;
    if description.len() > 100_000 {
        return Err(Error::BadRequest("project description too long".into()));
    }

    Ok(())
}

fn validate_sprint(
    name: &str,
    goal: &str,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
) -> Result<()> {
    text(name, 200)?;
    crate::domain::timestamp(starts_at)?;
    crate::domain::timestamp(ends_at)?;
    if ends_at <= starts_at {
        return Err(Error::BadRequest("sprint end must follow start".into()));
    }

    if goal.len() > 100_000 {
        return Err(Error::BadRequest("sprint goal too long".into()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support as support;
    use serde_json::json;

    async fn setup() -> (support::TestDatabase, Store, Uuid, Uuid) {
        let database = support::TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let owner = store
            .register(crate::auth::Register {
                email: format!("owner-{}@example.com", Uuid::new_v4()),
                password: "team-stage-id-password".into(),
                display_name: "owner".into(),
                invitation: None,
            })
            .await
            .unwrap()
            .session()
            .unwrap()
            .profile
            .id;
        let workspace: Uuid = serde_json::from_value(
            store.create_workspace("Teams".into(), owner).await.unwrap()["id"].clone(),
        )
        .unwrap();
        (database, store, workspace, owner)
    }

    #[tokio::test]
    async fn teams_get_distinct_colors_and_editable_appearance() {
        let (database, store, workspace, owner) = setup().await;
        let run = |command: serde_json::Value| {
            let store = &store;
            async move {
                store
                    .operation(
                        workspace,
                        owner,
                        serde_json::from_value(command).unwrap(),
                        BTreeMap::new(),
                        None,
                        None,
                    )
                    .await
            }
        };
        let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
        run(json!({"type": "create_team", "id": first, "name": "A", "key": "A"}))
            .await
            .unwrap();
        run(json!({"type": "create_team", "id": second, "name": "B", "key": "B"}))
            .await
            .unwrap();
        let appearance = |id: Uuid| {
            sqlx::query_as::<_, (String, String)>("SELECT icon,color FROM teams WHERE id=$1")
                .bind(id)
                .fetch_one(&store.pool)
        };
        assert_eq!(
            appearance(first).await.unwrap(),
            ("users".into(), "violet".into())
        );
        assert_eq!(
            appearance(second).await.unwrap(),
            ("users".into(), "blue".into())
        );

        run(json!({"type": "set_team_appearance", "id": first, "icon": "rocket", "color": "teal"}))
            .await
            .unwrap();
        assert_eq!(
            appearance(first).await.unwrap(),
            ("rocket".into(), "teal".into())
        );
        for (icon, color) in [("nope", "teal"), ("rocket", "nope")] {
            let rejected = run(
                json!({"type": "set_team_appearance", "id": first, "icon": icon, "color": color}),
            )
            .await;
            assert!(matches!(rejected, Err(Error::BadRequest(_))));
        }

        store.pool.close().await;
        database.cleanup().await;
    }

    #[tokio::test]
    async fn create_team_honors_client_stage_ids() {
        let (database, store, workspace, owner) = setup().await;
        let team = Uuid::new_v4();
        let stages: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
        store
            .operation(
                workspace,
                owner,
                serde_json::from_value(json!({
                    "type": "create_team",
                    "id": team,
                    "name": "Team",
                    "key": "TEA",
                    "default_stage_ids": stages,
                }))
                .unwrap(),
                BTreeMap::new(),
                None,
                None,
            )
            .await
            .unwrap();

        let rows = sqlx::query(
            "SELECT id,name,kind,position FROM stages WHERE workspace_id=$1 AND team_id=$2 ORDER BY position",
        )
        .bind(workspace)
        .bind(team)
        .fetch_all(&store.pool)
        .await
        .unwrap();
        let kinds: Vec<(Uuid, String, String, i64)> = rows
            .into_iter()
            .map(|row| {
                (
                    row.try_get("id").unwrap(),
                    row.try_get("name").unwrap(),
                    row.try_get("kind").unwrap(),
                    row.try_get("position").unwrap(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                (stages[0], "Backlog".into(), "backlog".into(), 0),
                (stages[1], "Todo".into(), "planned".into(), 1),
                (stages[2], "In progress".into(), "active".into(), 2),
                (stages[3], "Done".into(), "done".into(), 3),
            ]
        );

        store.pool.close().await;
        database.cleanup().await;
    }

    #[tokio::test]
    async fn create_team_rejects_wrong_stage_id_count() {
        let (database, store, workspace, owner) = setup().await;
        for count in [0, 3, 5] {
            let stages: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();
            let result = store
                .operation(
                    workspace,
                    owner,
                    serde_json::from_value(json!({
                        "type": "create_team",
                        "name": "Team",
                        "key": "TEA",
                        "default_stage_ids": stages,
                    }))
                    .unwrap(),
                    BTreeMap::new(),
                    None,
                    None,
                )
                .await;
            assert!(
                matches!(result, Err(Error::BadRequest(ref message)) if message == "default_stage_ids must contain exactly 4 ids"),
                "count {count}: {result:?}"
            );
        }

        store.pool.close().await;
        database.cleanup().await;
    }

    #[tokio::test]
    async fn create_team_rejects_colliding_stage_ids() {
        let (database, store, workspace, owner) = setup().await;
        let stages: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
        store
            .operation(
                workspace,
                owner,
                serde_json::from_value(json!({
                    "type": "create_team",
                    "name": "First",
                    "key": "FIR",
                    "default_stage_ids": stages,
                }))
                .unwrap(),
                BTreeMap::new(),
                None,
                None,
            )
            .await
            .unwrap();

        let team_id = Uuid::new_v4();
        let duplicate = Uuid::new_v4();
        for (id, ids) in [
            (
                None,
                vec![stages[0], Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()],
            ),
            (
                None,
                vec![owner, Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()],
            ),
            (
                None,
                vec![duplicate, duplicate, Uuid::new_v4(), Uuid::new_v4()],
            ),
            (
                Some(team_id),
                vec![team_id, Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()],
            ),
        ] {
            let result = store
                .operation(
                    workspace,
                    owner,
                    serde_json::from_value(json!({
                        "type": "create_team",
                        "id": id,
                        "name": "Second",
                        "key": "SEC",
                        "default_stage_ids": ids,
                    }))
                    .unwrap(),
                    BTreeMap::new(),
                    None,
                    None,
                )
                .await;
            assert!(
                matches!(result, Err(Error::Conflict(_))),
                "colliding stage id: {result:?}"
            );
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM teams WHERE workspace_id=$1")
            .bind(workspace)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "collisions must roll back the entire team create");

        store.pool.close().await;
        database.cleanup().await;
    }
}
