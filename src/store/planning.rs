use super::*;

impl Operation<'_> {
    pub(super) async fn planning(&mut self, command: Command) -> Result<Option<Uuid>> {
        let id = match command {
            Command::CreateTeam {
                id,
                name,
                mut members,
            } => {
                self.admin()?;
                text(&name, 200)?;
                self.capacity("teams", 200).await?;
                members.sort_unstable();
                members.dedup();
                for user in &members {
                    self.member(*user).await?;
                }

                let id = self.reserve_client_id(id).await?;
                sqlx::query("INSERT INTO teams(id,workspace_id,name,archive_after_days) VALUES($1,$2,$3,30)")
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(name)
                    .execute(&mut *self.tx)
                    .await
                    .map_err(id_conflict)?;
                self.created("teams", id);
                for user in members {
                    sqlx::query(
                        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
                    )
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(user)
                    .execute(&mut *self.tx)
                    .await?;
                }

                for (position, (name, kind)) in [
                    ("Backlog", StageKind::Backlog),
                    ("Todo", StageKind::Planned),
                    ("In progress", StageKind::Active),
                    ("Done", StageKind::Done),
                ]
                .into_iter()
                .enumerate()
                {
                    let stage_id = Uuid::new_v4();
                    sqlx::query("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,$4,$5,$6)")
                        .bind(stage_id)
                        .bind(self.workspace_id)
                        .bind(id)
                        .bind(name)
                        .bind(enum_text(&kind))
                        .bind(position as i64)
                        .execute(&mut *self.tx)
                        .await?;
                    self.created("stages", stage_id);
                }

                id
            }

            Command::SetTeamMembers { id, mut members } => {
                self.admin()?;
                members.sort_unstable();
                members.dedup();
                for user in &members {
                    self.member(*user).await?;
                }

                self.touch("teams", id).await?;
                sqlx::query("DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;

                for user in members {
                    sqlx::query(
                        "INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)",
                    )
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(user)
                    .execute(&mut *self.tx)
                    .await?;
                }

                id
            }

            Command::SetTeamArchive {
                id,
                archive_after_days,
            } => {
                self.admin()?;
                crate::domain::validate_archive_days(archive_after_days)?;
                self.touch("teams", id).await?;
                sqlx::query(
                    "UPDATE teams SET archive_after_days=$3 WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(archive_after_days.map(i64::from))
                .execute(&mut *self.tx)
                .await?;

                id
            }

            Command::CreateStage {
                id,
                team_id,
                name,
                kind,
                position,
            } => {
                self.admin()?;
                text(&name, 200)?;
                self.lock_team(team_id, true).await?;
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM stages WHERE workspace_id=$1 AND team_id=$2",
                )
                .bind(self.workspace_id)
                .bind(team_id)
                .fetch_one(&mut *self.tx)
                .await?;

                if count >= 100 {
                    return Err(Error::BadRequest(
                        "team must contain 1 to 100 stages".into(),
                    ));
                }

                let id = self.reserve_client_id(id).await?;
                sqlx::query("INSERT INTO stages(id,workspace_id,team_id,name,kind,position) VALUES($1,$2,$3,$4,$5,$6)")
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(team_id)
                    .bind(name)
                    .bind(enum_text(&kind))
                    .bind(position)
                    .execute(&mut *self.tx)
                    .await
                    .map_err(id_conflict)?;
                self.created("stages", id);
                id
            }

            Command::UpdateStage {
                team_id,
                id,
                name,
                kind,
                position,
            } => {
                self.admin()?;
                text(&name, 200)?;
                self.lock_graph().await?;
                self.lock_team(team_id, false).await?;
                let row = sqlx::query("SELECT kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=$3 FOR UPDATE")
                    .bind(self.workspace_id)
                    .bind(team_id)
                    .bind(id)
                    .fetch_optional(&mut *self.tx)
                    .await?
                    .ok_or(Error::NotFound)?;

                let previous: String = row.try_get("kind")?;
                self.touch("stages", id).await?;
                let next = enum_text(&kind);
                let issues = if previous != next {
                    self.stage_issues(id).await?
                } else {
                    vec![]
                };

                sqlx::query("UPDATE stages SET name=$4,kind=$5,position=$6 WHERE workspace_id=$1 AND team_id=$2 AND id=$3")
                    .bind(self.workspace_id)
                    .bind(team_id)
                    .bind(id)
                    .bind(name)
                    .bind(&next)
                    .bind(position)
                    .execute(&mut *self.tx)
                    .await?;

                if previous != next {
                    self.validate_workflow().await?;
                    // Maintain the Done-entry clock for auto-archive (Done only, not cancelled).
                    if next == "done" {
                        sqlx::query("UPDATE issues SET done_at=COALESCE(done_at,now()),updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL AND done_at IS NULL")
                            .bind(self.workspace_id)
                            .bind(id)
                            .execute(&mut *self.tx)
                            .await?;
                    } else if previous == "done" {
                        sqlx::query("UPDATE issues SET done_at=NULL,updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL")
                            .bind(self.workspace_id)
                            .bind(id)
                            .execute(&mut *self.tx)
                            .await?;
                    }
                    for (issue_id, deleted) in issues {
                        self.schedule_reminder(issue_id).await?;
                        if !deleted && !terminal(&previous) && terminal(&next) {
                            self.activity("issue_completed", Some(issue_id), vec![])
                                .await?;
                        }
                    }
                }

                id
            }

            Command::DeleteStage {
                team_id,
                id,
                replacement,
            } => {
                self.admin()?;
                if id == replacement {
                    return Err(Error::BadRequest("invalid replacement stage".into()));
                }

                // Sync locks its connection before the issue graph.
                let mappings = self.lock_stage_mappings(id).await?;
                self.lock_graph().await?;
                self.lock_team(team_id, true).await?;
                let stages = sqlx::query("SELECT id,kind FROM stages WHERE workspace_id=$1 AND team_id=$2 AND id=ANY($3) ORDER BY id FOR UPDATE")
                    .bind(self.workspace_id)
                    .bind(team_id)
                    .bind(vec![id, replacement])
                    .fetch_all(&mut *self.tx)
                    .await?;

                if stages.len() != 2 {
                    return Err(Error::BadRequest("invalid replacement stage".into()));
                }

                let previous: String = stages
                    .iter()
                    .find(|row| row.get::<Uuid, _>("id") == id)
                    .unwrap()
                    .try_get("kind")?;

                let next: String = stages
                    .iter()
                    .find(|row| row.get::<Uuid, _>("id") == replacement)
                    .unwrap()
                    .try_get("kind")?;

                self.touch("stages", id).await?;
                let issues = self.stage_issues(id).await?;
                for (issue_id, _) in &issues {
                    self.touch("issues", *issue_id).await?;
                }

                sqlx::query("SELECT set_config('blackwall.stage_migration', $1, true)")
                    .bind(serde_json::json!({"workspace_id": self.workspace_id, "from": id, "to": replacement}).to_string())
                    .execute(&mut *self.tx)
                    .await?;
                sqlx::query("UPDATE issues SET stage_id=$3,updated_at=now() WHERE workspace_id=$1 AND stage_id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(replacement)
                    .execute(&mut *self.tx)
                    .await?;

                sqlx::query("SELECT set_config('blackwall.stage_migration', '', true)")
                    .execute(&mut *self.tx)
                    .await?;

                self.replace_stage_mappings(mappings, id, replacement)
                    .await?;

                sqlx::query("DELETE FROM stages WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;

                self.validate_workflow().await?;
                if next == "done" {
                    sqlx::query("UPDATE issues SET done_at=COALESCE(done_at,now()),updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL AND done_at IS NULL")
                        .bind(self.workspace_id)
                        .bind(replacement)
                        .execute(&mut *self.tx)
                        .await?;
                } else if previous == "done" {
                    sqlx::query("UPDATE issues SET done_at=NULL,updated_at=now() WHERE workspace_id=$1 AND stage_id=$2 AND archived_at IS NULL")
                        .bind(self.workspace_id)
                        .bind(replacement)
                        .execute(&mut *self.tx)
                        .await?;
                }
                for (issue_id, deleted) in issues {
                    self.schedule_reminder(issue_id).await?;
                    if !deleted && !terminal(&previous) && terminal(&next) {
                        self.activity("issue_completed", Some(issue_id), vec![])
                            .await?;
                    }
                }

                id
            }

            Command::CreateLabel { id, name, color } => {
                validate_label(&name, &color)?;
                self.capacity("labels", 1000).await?;
                let id = self.reserve_client_id(id).await?;
                sqlx::query("INSERT INTO labels(id,workspace_id,name,color) VALUES($1,$2,$3,$4)")
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(name)
                    .bind(color)
                    .execute(&mut *self.tx)
                    .await
                    .map_err(id_conflict)?;
                self.created("labels", id);
                id
            }

            Command::UpdateLabel { id, name, color } => {
                validate_label(&name, &color)?;
                self.touch("labels", id).await?;
                sqlx::query("UPDATE labels SET name=$3,color=$4 WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(name)
                    .bind(color)
                    .execute(&mut *self.tx)
                    .await?;

                id
            }

            Command::CreateProject {
                id,
                name,
                description,
                mut team_ids,
            } => {
                validate_project(&name, &description)?;
                self.capacity("projects", 1000).await?;
                team_ids.sort_unstable();
                team_ids.dedup();
                for team in &team_ids {
                    self.lock_team(*team, false).await?;
                }

                let id = self.reserve_client_id(id).await?;
                sqlx::query(
                    "INSERT INTO projects(id,workspace_id,name,description) VALUES($1,$2,$3,$4)",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(name)
                .bind(description)
                .execute(&mut *self.tx)
                .await
                .map_err(id_conflict)?;

                self.replace_project_teams(id, team_ids).await?;
                self.created("projects", id);
                id
            }

            Command::UpdateProject {
                id,
                name,
                description,
                mut team_ids,
            } => {
                validate_project(&name, &description)?;
                team_ids.sort_unstable();
                team_ids.dedup();
                for team in &team_ids {
                    self.lock_team(*team, false).await?;
                }

                self.touch("projects", id).await?;
                let has_issues: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND project_id=$2 AND NOT(team_id=ANY($3)))")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(&team_ids)
                    .fetch_one(&mut *self.tx)
                    .await?;

                if has_issues {
                    return Err(Error::Conflict("project teams still contain issues".into()));
                }

                sqlx::query(
                    "UPDATE projects SET name=$3,description=$4 WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(name)
                .bind(description)
                .execute(&mut *self.tx)
                .await?;

                self.replace_project_teams(id, team_ids).await?;

                id
            }

            Command::CreateMilestone {
                id,
                project_id,
                name,
                deadline,
            } => {
                text(&name, 200)?;
                self.capacity("milestones", 5000).await?;
                sqlx::query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE")
                    .bind(self.workspace_id)
                    .bind(project_id)
                    .fetch_optional(&mut *self.tx)
                    .await?
                    .ok_or(Error::NotFound)?;

                let id = self.reserve_client_id(id).await?;
                sqlx::query("INSERT INTO milestones(id,workspace_id,project_id,name,deadline) VALUES($1,$2,$3,$4,$5)")
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(project_id)
                    .bind(name)
                    .bind(deadline)
                    .execute(&mut *self.tx)
                    .await
                    .map_err(id_conflict)?;
                self.created("milestones", id);
                id
            }

            Command::UpdateMilestone { id, name, deadline } => {
                text(&name, 200)?;
                self.touch("milestones", id).await?;
                sqlx::query(
                    "UPDATE milestones SET name=$3,deadline=$4 WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(name)
                .bind(deadline)
                .execute(&mut *self.tx)
                .await?;

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
                validate_sprint(&name, &goal, starts_at, ends_at)?;
                self.capacity("sprints", 2000).await?;
                self.lock_team(team_id, false).await?;
                let id = self.reserve_client_id(id).await?;
                sqlx::query("INSERT INTO sprints(id,workspace_id,team_id,name,goal,starts_at,ends_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,'planned')")
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(team_id)
                    .bind(name)
                    .bind(goal)
                    .bind(starts_at)
                    .bind(ends_at)
                    .execute(&mut *self.tx)
                    .await
                    .map_err(id_conflict)?;
                self.created("sprints", id);
                id
            }

            Command::UpdateSprint {
                id,
                name,
                goal,
                starts_at,
                ends_at,
                state,
            } => {
                validate_sprint(&name, &goal, starts_at, ends_at)?;
                if matches!(state, SprintState::Completed | SprintState::Archived) {
                    return Err(Error::BadRequest(
                        "use completion or archive command".into(),
                    ));
                }

                self.touch("sprints", id).await?;
                let previous: String =
                    sqlx::query_scalar("SELECT state FROM sprints WHERE workspace_id=$1 AND id=$2")
                        .bind(self.workspace_id)
                        .bind(id)
                        .fetch_one(&mut *self.tx)
                        .await?;

                if terminal_sprint(&previous) {
                    return Err(Error::Conflict("sprint already completed".into()));
                }

                sqlx::query("UPDATE sprints SET name=$3,goal=$4,starts_at=$5,ends_at=$6,state=$7 WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(name)
                    .bind(goal)
                    .bind(starts_at)
                    .bind(ends_at)
                    .bind(enum_text(&state))
                    .execute(&mut *self.tx)
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
                self.touch("sprints", id).await?;
                let state: String =
                    sqlx::query_scalar("SELECT state FROM sprints WHERE workspace_id=$1 AND id=$2")
                        .bind(self.workspace_id)
                        .bind(id)
                        .fetch_one(&mut *self.tx)
                        .await?;

                if !terminal_sprint(&state) {
                    return Err(Error::BadRequest("complete sprint before archiving".into()));
                }

                sqlx::query("UPDATE sprints SET state='archived' WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;

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

    async fn lock_team(&mut self, id: Uuid, exclusive: bool) -> Result<()> {
        let sql = if exclusive {
            "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 FOR UPDATE"
        } else {
            "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2 FOR SHARE"
        };

        sqlx::query(sql)
            .bind(self.workspace_id)
            .bind(id)
            .fetch_optional(&mut *self.tx)
            .await?
            .ok_or(Error::NotFound)?;

        Ok(())
    }

    async fn lock_stage_mappings(
        &mut self,
        stage: Uuid,
    ) -> Result<Vec<(Uuid, Vec<crate::openproject::Mapping>)>> {
        let rows = sqlx::query("SELECT id,projects FROM openproject_connections WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(projects) mapping, jsonb_each_text(COALESCE(mapping->'stage_mapping','{}'::jsonb)) entry WHERE entry.value=$2) ORDER BY id FOR UPDATE")
            .bind(self.workspace_id).bind(stage.to_string()).fetch_all(&mut *self.tx).await?;
        rows.into_iter()
            .map(|row| {
                Ok((
                    row.try_get("id")?,
                    serde_json::from_value(row.try_get("projects")?)?,
                ))
            })
            .collect()
    }

    async fn replace_stage_mappings(
        &mut self,
        mappings: Vec<(Uuid, Vec<crate::openproject::Mapping>)>,
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
            sqlx::query("UPDATE openproject_connections SET projects=$3,generation=generation+1,next_run_at=clock_timestamp(),status='pending',last_error='' WHERE workspace_id=$1 AND id=$2")
                .bind(self.workspace_id).bind(connection).bind(serde_json::to_value(projects)?)
                .execute(&mut *self.tx).await?;
            sqlx::query("UPDATE jobs SET state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE queue='openproject' AND state='pending' AND payload->>'connection_id'=$1")
                .bind(connection.to_string()).execute(&mut *self.tx).await?;
        }
        Ok(())
    }

    async fn stage_issues(&mut self, stage_id: Uuid) -> Result<Vec<(Uuid, bool)>> {
        let rows = sqlx::query("SELECT id,deleted_at IS NOT NULL AS deleted FROM issues WHERE workspace_id=$1 AND stage_id=$2 ORDER BY id FOR UPDATE")
            .bind(self.workspace_id)
            .bind(stage_id)
            .fetch_all(&mut *self.tx)
            .await?;

        rows.into_iter()
            .map(|row| Ok((row.try_get("id")?, row.try_get("deleted")?)))
            .collect()
    }

    async fn replace_project_teams(&mut self, project_id: Uuid, team_ids: Vec<Uuid>) -> Result<()> {
        sqlx::query("DELETE FROM project_teams WHERE workspace_id=$1 AND project_id=$2 AND NOT(team_id=ANY($3))")
            .bind(self.workspace_id)
            .bind(project_id)
            .bind(&team_ids)
            .execute(&mut *self.tx)
            .await?;

        for team_id in team_ids {
            sqlx::query("INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
                .bind(self.workspace_id)
                .bind(project_id)
                .bind(team_id)
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
        let sprints = sqlx::query("SELECT id,team_id,state FROM sprints WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
            .bind(self.workspace_id)
            .bind(sprint_ids)
            .fetch_all(&mut *self.tx)
            .await?;

        let sprint = sprints
            .iter()
            .find(|row| row.get::<Uuid, _>("id") == id)
            .ok_or(Error::NotFound)?;

        let state: String = sprint.try_get("state")?;
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
                .find(|row| row.get::<Uuid, _>("id") == target)
                .ok_or(Error::NotFound)?;

            if target == id
                || target_row.get::<Uuid, _>("team_id") != sprint.get::<Uuid, _>("team_id")
                || terminal_sprint(&target_row.get::<String, _>("state"))
            {
                return Err(Error::BadRequest("invalid carryover sprint".into()));
            }
        }

        let rows = sqlx::query("SELECT i.id,i.estimate,s.kind FROM issues i JOIN stages s ON s.id=i.stage_id AND s.workspace_id=i.workspace_id WHERE i.workspace_id=$1 AND i.sprint_id=$2 AND i.deleted_at IS NULL ORDER BY i.id FOR UPDATE OF i")
            .bind(self.workspace_id)
            .bind(id)
            .fetch_all(&mut *self.tx)
            .await?;

        let mut completed = 0_i64;
        let mut effort = 0_i64;
        for row in &rows {
            let issue_id: Uuid = row.try_get("id")?;
            self.touch("issues", issue_id).await?;
            effort += row.try_get::<Option<i64>, _>("estimate")?.unwrap_or(0);
            if terminal(&row.try_get::<String, _>("kind")?) {
                completed += 1;
            } else {
                sqlx::query("UPDATE issues SET sprint_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(issue_id)
                    .bind(carryover)
                    .execute(&mut *self.tx)
                    .await?;
            }
        }

        sqlx::query("INSERT INTO sprint_outcomes(workspace_id,sprint_id,total,completed,effort) VALUES($1,$2,$3,$4,$5)")
            .bind(self.workspace_id)
            .bind(id)
            .bind(rows.len() as i64)
            .bind(completed)
            .bind(effort)
            .execute(&mut *self.tx)
            .await?;

        sqlx::query("UPDATE sprints SET state='completed' WHERE workspace_id=$1 AND id=$2")
            .bind(self.workspace_id)
            .bind(id)
            .execute(&mut *self.tx)
            .await?;

        Ok(())
    }
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
    if ends_at <= starts_at {
        return Err(Error::BadRequest("sprint end must follow start".into()));
    }

    if goal.len() > 100_000 {
        return Err(Error::BadRequest("sprint goal too long".into()));
    }

    Ok(())
}
