use super::*;
use crate::jobs::{Email, Grant, Job};
use std::collections::BTreeSet;

impl Operation<'_> {
    pub(super) async fn discussion(
        &mut self,
        command: Command,
        upload: Option<NewAttachment>,
    ) -> Result<Option<Uuid>> {
        let now = Utc::now();
        let result = match command {
            Command::AddAttachment {
                issue_id,
                attachment,
            } => {
                self.touch("issues", issue_id).await?;
                self.reject_archived_issue(issue_id).await?;
                self.discussion_issue(issue_id).await?;
                self.insert_attachment(issue_id, None, attachment, upload)
                    .await?;
                Some(issue_id)
            }

            Command::AttachCommentFile {
                comment_id,
                attachment,
            } => {
                let row = self
                    .discussion_record("comments", "author", comment_id)
                    .await?;
                self.author_or_admin(row.try_get("author")?)?;
                let issue_id = row.try_get("issue_id")?;
                self.discussion_issue(issue_id).await?;
                self.touch("comments", comment_id).await?;
                self.insert_attachment(issue_id, Some(comment_id), attachment, upload)
                    .await?;
                Some(comment_id)
            }

            Command::RemoveAttachment {
                issue_id,
                attachment_id,
            } => {
                self.touch("issues", issue_id).await?;
                self.reject_archived_issue(issue_id).await?;
                self.discussion_issue(issue_id).await?;

                let deleted = sqlx::query(
                    "DELETE FROM attachments WHERE workspace_id=$1 AND issue_id=$2 AND \
                    id=$3 AND comment_id IS NULL",
                )
                .bind(self.workspace_id)
                .bind(issue_id)
                .bind(attachment_id)
                .execute(&mut *self.tx)
                .await?;
                if deleted.rows_affected() == 0 {
                    return Err(Error::NotFound);
                }

                Some(issue_id)
            }

            Command::AddComment {
                id,
                issue_id,
                body,
                mentions,
                attachments,
            } => {
                self.discussion_issue(issue_id).await?;
                crate::domain::text(&body, 100_000)?;
                let mentions: BTreeSet<_> = mentions.into_iter().collect();

                for user in &mentions {
                    self.member(*user).await?;
                }

                self.capacity("comments", 20_000).await?;
                let id = self.reserve_client_id(id).await?;

                sqlx::query(
                    "INSERT INTO comments(id,workspace_id,issue_id,author,body,\
                    created_at) VALUES($1,$2,$3,$4,$5,$6)",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(issue_id)
                .bind(self.actor)
                .bind(&body)
                .bind(now)
                .execute(&mut *self.tx)
                .await
                .map_err(id_conflict)?;
                for user in &mentions {
                    sqlx::query(
                        "INSERT INTO comment_mentions(workspace_id,comment_id,user_id) \
                        VALUES($1,$2,$3)",
                    )
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(user)
                    .execute(&mut *self.tx)
                    .await?;
                }

                for attachment in attachments {
                    let changed = sqlx::query(
                        "UPDATE attachments SET comment_id=$1 WHERE workspace_id=$2 AND \
                        issue_id=$3 AND id=$4 AND uploader_id=$5 AND comment_id IS NULL",
                    )
                    .bind(id)
                    .bind(self.workspace_id)
                    .bind(issue_id)
                    .bind(attachment.id)
                    .bind(self.actor)
                    .execute(&mut *self.tx)
                    .await?;
                    if changed.rows_affected() != 1 {
                        return Err(Error::BadRequest(
                            "attachment must be uploaded to this issue first".into(),
                        ));
                    }
                }

                let followers: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT user_id FROM issue_followers WHERE workspace_id=$1 AND \
                    issue_id=$2 AND user_id<>$3 ORDER BY user_id",
                )
                .bind(self.workspace_id)
                .bind(issue_id)
                .bind(self.actor)
                .fetch_all(&mut *self.tx)
                .await?;
                for user in followers {
                    self.notify(
                        user,
                        Some(issue_id),
                        AlertKind::Reply,
                        body.clone(),
                        format!("reply:{id}:{user}"),
                    )
                    .await?;
                }

                for user in mentions {
                    if user != self.actor {
                        self.notify(
                            user,
                            Some(issue_id),
                            AlertKind::Mention,
                            body.clone(),
                            format!("mention:{id}:{user}"),
                        )
                        .await?;
                    }
                }

                self.created("comments", id);

                Some(id)
            }

            Command::EditComment { id, body, mentions } => {
                crate::domain::text(&body, 100_000)?;

                let row = self.discussion_record("comments", "author", id).await?;
                self.author_or_admin(row.try_get("author")?)?;
                let mentions: BTreeSet<_> = mentions.into_iter().collect();

                for user in &mentions {
                    self.member(*user).await?;
                }

                self.touch("comments", id).await?;

                sqlx::query(
                    "UPDATE comments SET body=$3,edited_at=$4 WHERE workspace_id=$1 AND \
                        id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(body)
                .bind(now)
                .execute(&mut *self.tx)
                .await?;

                sqlx::query("DELETE FROM comment_mentions WHERE workspace_id=$1 AND comment_id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;
                for user in mentions {
                    sqlx::query(
                        "INSERT INTO comment_mentions(workspace_id,comment_id,user_id) \
                        VALUES($1,$2,$3)",
                    )
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(user)
                    .execute(&mut *self.tx)
                    .await?;
                }

                Some(id)
            }

            Command::DeleteComment { id } => {
                let row = self.discussion_record("comments", "author", id).await?;
                self.author_or_admin(row.try_get("author")?)?;
                self.touch("comments", id).await?;

                sqlx::query("DELETE FROM comments WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }

            Command::LogTime {
                id,
                issue_id,
                minutes,
                note,
                logged_at,
            } => {
                self.discussion_issue(issue_id).await?;
                validate_time(minutes, &note)?;
                self.capacity("time_entries", 20_000).await?;
                let id = self.reserve_client_id(id).await?;

                sqlx::query(
                    "INSERT INTO time_entries(id,workspace_id,issue_id,user_id,minutes,\
                    note,logged_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(issue_id)
                .bind(self.actor)
                .bind(minutes as i64)
                .bind(note)
                .bind(logged_at)
                .execute(&mut *self.tx)
                .await
                .map_err(id_conflict)?;
                self.created("time_entries", id);

                Some(id)
            }

            Command::UpdateTime {
                id,
                minutes,
                note,
                logged_at,
            } => {
                validate_time(minutes, &note)?;

                let row = self
                    .discussion_record("time_entries", "user_id", id)
                    .await?;
                self.author_or_admin(row.try_get("user_id")?)?;
                self.touch("time_entries", id).await?;

                sqlx::query(
                    "UPDATE time_entries SET minutes=$3,note=$4,logged_at=$5 WHERE \
                    workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(minutes as i64)
                .bind(note)
                .bind(logged_at)
                .execute(&mut *self.tx)
                .await?;
                Some(id)
            }

            Command::DeleteTime { id } => {
                let row = self
                    .discussion_record("time_entries", "user_id", id)
                    .await?;
                self.author_or_admin(row.try_get("user_id")?)?;
                self.touch("time_entries", id).await?;

                sqlx::query("DELETE FROM time_entries WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }

            Command::SaveView {
                id,
                name,
                shared,
                filter,
            } => {
                crate::domain::text(&name, 200)?;
                self.capacity("saved_views", 5_000).await?;
                let id = self.reserve_client_id(id).await?;

                sqlx::query(
                    "INSERT INTO saved_views(id,workspace_id,owner,name,shared,filter) \
                    VALUES($1,$2,$3,$4,$5,$6)",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(self.actor)
                .bind(name)
                .bind(shared)
                .bind(serde_json::to_value(filter)?)
                .execute(&mut *self.tx)
                .await
                .map_err(id_conflict)?;
                self.created("saved_views", id);

                Some(id)
            }

            Command::UpdateView {
                id,
                name,
                shared,
                filter,
            } => {
                crate::domain::text(&name, 200)?;

                let owner: Uuid = sqlx::query_scalar(
                    "SELECT owner FROM saved_views WHERE workspace_id=$1 AND id=$2 FOR \
                        UPDATE",
                )
                .bind(self.workspace_id)
                .bind(id)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
                self.author_or_admin(owner)?;

                if shared && self.role == Role::Viewer {
                    return Err(Error::Forbidden);
                }

                self.touch("saved_views", id).await?;

                sqlx::query(
                    "UPDATE saved_views SET name=$3,shared=$4,filter=$5 WHERE \
                    workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(name)
                .bind(shared)
                .bind(serde_json::to_value(filter)?)
                .execute(&mut *self.tx)
                .await?;
                Some(id)
            }

            Command::DeleteView { id } => {
                let owner: Uuid = sqlx::query_scalar(
                    "SELECT owner FROM saved_views WHERE workspace_id=$1 AND id=$2 FOR \
                        UPDATE",
                )
                .bind(self.workspace_id)
                .bind(id)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
                self.author_or_admin(owner)?;
                self.touch("saved_views", id).await?;

                sqlx::query("DELETE FROM saved_views WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }

            Command::Invite { email, role, .. } => {
                self.admin()?;

                if role == Role::Owner && self.role != Role::Owner {
                    return Err(Error::Forbidden);
                }
                validate_email(&email)?;
                let email = email.to_lowercase();
                self.discussion_lock(&format!("invitation:{email}")).await?;

                sqlx::query(
                    "UPDATE invitations SET state='expired',token_hash='',\
                    version=version+1 WHERE workspace_id=$1 AND lower(email)=$2 AND \
                    state='pending' AND expires_at<=$3",
                )
                .bind(self.workspace_id)
                .bind(&email)
                .bind(now)
                .execute(&mut *self.tx)
                .await?;

                let pending: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM invitations WHERE workspace_id=$1 AND \
                    lower(email)=$2 AND state='pending')",
                )
                .bind(self.workspace_id)
                .bind(&email)
                .fetch_one(&mut *self.tx)
                .await?;
                if pending {
                    return Err(Error::Conflict("invitation already pending".into()));
                }

                self.capacity("invitations", 5_000).await?;
                let id = Uuid::new_v4();
                let token = crate::auth::token();
                let hash = crate::auth::hash(&token);

                sqlx::query(
                    "INSERT INTO invitations(id,workspace_id,email,role,token_hash,\
                    expires_at,state) VALUES($1,$2,$3,$4,$5,$6,'pending')",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(&email)
                .bind(enum_text(&role))
                .bind(&hash)
                .bind(now + chrono::Duration::days(7))
                .execute(&mut *self.tx)
                .await?;
                self.invitation_email(id, email, token, hash).await?;

                self.created("invitations", id);

                Some(id)
            }

            Command::ResendInvitation { id, .. } => {
                self.admin()?;

                let email: String = sqlx::query_scalar(
                    "SELECT email FROM invitations WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .fetch_optional(&mut *self.tx)
                .await?
                .ok_or(Error::NotFound)?;
                self.discussion_lock(&format!("invitation:{email}")).await?;
                self.touch("invitations", id).await?;

                let row = sqlx::query(
                    "SELECT email,state,role FROM invitations WHERE workspace_id=$1 AND \
                        id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .fetch_one(&mut *self.tx)
                .await?;

                if matches!(row.get::<&str, _>("state"), "accepted" | "cancelled") {
                    return Err(Error::Conflict("invitation is no longer pending".into()));
                }

                if row.get::<&str, _>("role") == "owner" && self.role != Role::Owner {
                    return Err(Error::Forbidden);
                }

                let other: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM invitations WHERE workspace_id=$1 AND \
                    lower(email)=lower($2) AND state='pending' AND id<>$3 AND \
                    expires_at>$4)",
                )
                .bind(self.workspace_id)
                .bind(&email)
                .bind(id)
                .bind(now)
                .fetch_one(&mut *self.tx)
                .await?;
                if other {
                    return Err(Error::Conflict("invitation already pending".into()));
                }

                sqlx::query(
                    "UPDATE invitations SET state='expired',token_hash='',\
                    version=version+1 WHERE workspace_id=$1 AND lower(email)=lower($2) \
                    AND state='pending' AND id<>$3 AND expires_at<=$4",
                )
                .bind(self.workspace_id)
                .bind(&email)
                .bind(id)
                .bind(now)
                .execute(&mut *self.tx)
                .await?;

                let token = crate::auth::token();
                let hash = crate::auth::hash(&token);

                sqlx::query(
                    "UPDATE invitations SET token_hash=$3,expires_at=$4,state='pending' \
                    WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .bind(&hash)
                .bind(now + chrono::Duration::days(7))
                .execute(&mut *self.tx)
                .await?;
                self.invitation_email(id, email, token, hash).await?;

                Some(id)
            }

            Command::CancelInvitation { id } => {
                self.admin()?;
                self.touch("invitations", id).await?;

                let state: String = sqlx::query_scalar(
                    "SELECT state FROM invitations WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .fetch_one(&mut *self.tx)
                .await?;

                if state == "accepted" {
                    return Err(Error::Conflict("invitation already accepted".into()));
                }

                sqlx::query(
                    "UPDATE invitations SET state='cancelled',token_hash='' WHERE \
                    workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .execute(&mut *self.tx)
                .await?;
                Some(id)
            }

            Command::SetRole { user_id, role } => {
                self.admin()?;
                let old = self.member_role(user_id).await?;

                if (old == "owner" || role == Role::Owner) && self.role != Role::Owner {
                    return Err(Error::Forbidden);
                }

                if old == "owner" && role != Role::Owner {
                    self.retain_owner().await?;
                }

                self.touch("workspace_members", user_id).await?;

                sqlx::query(
                    "UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND \
                        user_id=$2",
                )
                .bind(self.workspace_id)
                .bind(user_id)
                .bind(enum_text(&role))
                .execute(&mut *self.tx)
                .await?;

                Some(user_id)
            }

            Command::RemoveMember { user_id } => {
                self.admin()?;

                if self.member_role(user_id).await? == "owner" {
                    if self.role != Role::Owner {
                        return Err(Error::Forbidden);
                    }

                    self.retain_owner().await?;
                }

                self.touch("workspace_members", user_id).await?;
                self.lock_graph().await?;

                sqlx::query(
                    "SELECT id FROM issues WHERE workspace_id=$1 AND (assignee=$2 OR \
                    EXISTS(SELECT 1 FROM issue_followers f WHERE f.workspace_id=$1 AND \
                    f.issue_id=issues.id AND f.user_id=$2)) ORDER BY id FOR UPDATE",
                )
                .bind(self.workspace_id)
                .bind(user_id)
                .fetch_all(&mut *self.tx)
                .await?;

                let changed = sqlx::query(
                    "UPDATE issues SET assignee=CASE WHEN assignee=$2 THEN NULL ELSE \
                    assignee END,version=version+1,updated_at=$3 WHERE workspace_id=$1 \
                    AND (assignee=$2 OR EXISTS(SELECT 1 FROM issue_followers f WHERE \
                    f.workspace_id=$1 AND f.issue_id=issues.id AND f.user_id=$2)) \
                    RETURNING id,version",
                )
                .bind(self.workspace_id)
                .bind(user_id)
                .bind(now)
                .fetch_all(&mut *self.tx)
                .await?;
                for row in changed {
                    let id: Uuid = row.try_get("id")?;
                    let version: i64 = row.try_get("version")?;
                    self.versions.insert(("issues".to_owned(), id), version);
                }

                sqlx::query(
                    "SELECT id FROM teams WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM \
                    team_members m WHERE m.workspace_id=$1 AND m.team_id=teams.id AND \
                    m.user_id=$2) ORDER BY id FOR UPDATE",
                )
                .bind(self.workspace_id)
                .bind(user_id)
                .fetch_all(&mut *self.tx)
                .await?;

                let changed = sqlx::query(
                    "UPDATE teams SET version=version+1 WHERE workspace_id=$1 AND \
                    EXISTS(SELECT 1 FROM team_members m WHERE m.workspace_id=$1 AND \
                    m.team_id=teams.id AND m.user_id=$2) RETURNING id,version",
                )
                .bind(self.workspace_id)
                .bind(user_id)
                .fetch_all(&mut *self.tx)
                .await?;
                for row in changed {
                    let id: Uuid = row.try_get("id")?;
                    let version: i64 = row.try_get("version")?;
                    self.versions.insert(("teams".to_owned(), id), version);
                }

                sqlx::query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2")
                    .bind(self.workspace_id)
                    .bind(user_id)
                    .execute(&mut *self.tx)
                    .await?;
                Some(user_id)
            }

            Command::MarkNotificationRead { id } => {
                self.own_notification(id).await?;
                self.touch("notifications", id).await?;

                sqlx::query("UPDATE notifications SET read_at=$3 WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(now)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }

            Command::MarkNotificationUnread { id } => {
                self.own_notification(id).await?;
                self.touch("notifications", id).await?;

                sqlx::query(
                    "UPDATE notifications SET read_at=NULL WHERE workspace_id=$1 AND id=$2",
                )
                .bind(self.workspace_id)
                .bind(id)
                .execute(&mut *self.tx)
                .await?;

                Some(id)
            }

            Command::MarkAllNotificationsRead => {
                let ids: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM notifications WHERE workspace_id=$1 AND user_id=$2 \
                    AND read_at IS NULL ORDER BY id FOR UPDATE",
                )
                .bind(self.workspace_id)
                .bind(self.actor)
                .fetch_all(&mut *self.tx)
                .await?;
                for id in ids {
                    self.touch("notifications", id).await?;

                    sqlx::query(
                        "UPDATE notifications SET read_at=$3 WHERE workspace_id=$1 AND id=$2",
                    )
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(now)
                    .execute(&mut *self.tx)
                    .await?;
                }

                None
            }

            Command::ConfigureAlerts {
                assignment,
                reply,
                change,
                mention,
                deadline,
            } => {
                self.discussion_lock(&format!("preferences:{}", self.actor))
                    .await?;

                let exists: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM alert_preferences WHERE workspace_id=$1 \
                    AND user_id=$2)",
                )
                .bind(self.workspace_id)
                .bind(self.actor)
                .fetch_one(&mut *self.tx)
                .await?;
                if exists {
                    self.touch("alert_preferences", self.actor).await?;
                } else {
                    self.created("alert_preferences", self.actor);
                }

                sqlx::query(
                    "INSERT INTO alert_preferences(workspace_id,user_id,assignment,reply,\
                    change,mention,deadline) VALUES($1,$2,$3,$4,$5,$6,$7) ON \
                    CONFLICT(workspace_id,user_id) DO UPDATE SET \
                    assignment=EXCLUDED.assignment,reply=EXCLUDED.reply,\
                    change=EXCLUDED.change,mention=EXCLUDED.mention,\
                    deadline=EXCLUDED.deadline",
                )
                .bind(self.workspace_id)
                .bind(self.actor)
                .bind(assignment)
                .bind(reply)
                .bind(change)
                .bind(mention)
                .bind(deadline)
                .execute(&mut *self.tx)
                .await?;
                None
            }

            Command::CreateIntegration {
                id,
                name,
                webhook_url,
                secret,
            } => {
                self.admin()?;
                crate::domain::text(&name, 200)?;
                validate_url(&webhook_url)?;
                crate::domain::text(&secret, 4096)?;
                self.capacity("integrations", 100).await?;
                let id = self.reserve_client_id(id).await?;

                sqlx::query(
                    "INSERT INTO integrations(id,workspace_id,name,webhook_url,secret) \
                    VALUES($1,$2,$3,$4,$5)",
                )
                .bind(id)
                .bind(self.workspace_id)
                .bind(name)
                .bind(webhook_url)
                .bind(secret)
                .execute(&mut *self.tx)
                .await
                .map_err(id_conflict)?;
                self.created("integrations", id);

                Some(id)
            }

            Command::UpdateIntegration { id, enabled } => {
                self.admin()?;
                self.touch("integrations", id).await?;

                sqlx::query("UPDATE integrations SET enabled=$3 WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .bind(enabled)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }

            Command::DeleteIntegration { id } => {
                self.admin()?;
                self.touch("integrations", id).await?;

                sqlx::query("DELETE FROM integrations WHERE workspace_id=$1 AND id=$2")
                    .bind(self.workspace_id)
                    .bind(id)
                    .execute(&mut *self.tx)
                    .await?;
                Some(id)
            }
            _ => {
                return Err(Error::Internal(
                    "command dispatched to wrong store module".into(),
                ));
            }
        };

        Ok(result)
    }

    fn author_or_admin(&self, author: Uuid) -> Result<()> {
        if author == self.actor {
            Ok(())
        } else {
            self.admin()
        }
    }

    async fn discussion_issue(&mut self, id: Uuid) -> Result<()> {
        sqlx::query(
            "SELECT id FROM issues WHERE workspace_id=$1 AND id=$2 AND \
            deleted_at IS NULL FOR SHARE",
        )
        .bind(self.workspace_id)
        .bind(id)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;
        Ok(())
    }

    async fn reject_archived_issue(&mut self, id: Uuid) -> Result<()> {
        let archived: bool = sqlx::query_scalar(
            "SELECT archived_at IS NOT NULL FROM issues WHERE workspace_id=$1 AND id=$2",
        )
        .bind(self.workspace_id)
        .bind(id)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;
        if archived {
            return Err(Error::Conflict("issue is archived".into()));
        }
        Ok(())
    }

    async fn discussion_record(
        &mut self,
        table: &str,
        author: &str,
        id: Uuid,
    ) -> Result<sqlx::postgres::PgRow> {
        assert!(matches!(
            (table, author),
            ("comments", "author") | ("time_entries", "user_id")
        ));

        sqlx::query(&format!(
            "SELECT issue_id,{author} FROM {table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE"
        ))
        .bind(self.workspace_id)
        .bind(id)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)
    }

    async fn insert_attachment(
        &mut self,
        issue_id: Uuid,
        comment_id: Option<Uuid>,
        metadata: Attachment,
        upload: Option<NewAttachment>,
    ) -> Result<()> {
        let upload =
            upload.ok_or_else(|| Error::BadRequest("use the attachment upload endpoint".into()))?;
        if upload.id != metadata.id
            || upload.issue_id != issue_id
            || upload.uploader_id != self.actor
        {
            return Err(Error::BadRequest(
                "attachment upload does not match target".into(),
            ));
        }
        crate::domain::text(&upload.filename, 200)?;

        if upload.bytes.len() > 5 * 1024 * 1024 || upload.content_type.len() > 200 {
            return Err(Error::BadRequest("attachment exceeds limits".into()));
        }

        sqlx::query(
            "INSERT INTO attachments(id,workspace_id,issue_id,comment_id,\
            uploader_id,filename,content_type,bytes,created_at) VALUES($1,$2,$3,\
            $4,$5,$6,$7,$8,$9)",
        )
        .bind(upload.id)
        .bind(self.workspace_id)
        .bind(issue_id)
        .bind(comment_id)
        .bind(self.actor)
        .bind(upload.filename)
        .bind(upload.content_type)
        .bind(upload.bytes)
        .bind(Utc::now())
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    async fn invitation_email(
        &mut self,
        id: Uuid,
        email: String,
        token: String,
        token_hash: String,
    ) -> Result<()> {
        Outbox::insert(
            &mut self.tx,
            &NewJob::now(
                format!("invitation:{id}:{token_hash}"),
                Job::Email(Email {
                    to: email,
                    subject: "You have been invited to a Blackwall workspace".into(),
                    token,
                    grant: Grant::Invitation {
                        workspace_id: self.workspace_id,
                        invitation_id: id,
                        token_hash,
                    },
                }),
            ),
        )
        .await
    }

    async fn member_role(&mut self, user: Uuid) -> Result<String> {
        sqlx::query_scalar(
            "SELECT role FROM workspace_members WHERE workspace_id=$1 AND \
                user_id=$2",
        )
        .bind(self.workspace_id)
        .bind(user)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)
    }

    async fn retain_owner(&mut self) -> Result<()> {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND \
                role='owner'",
        )
        .bind(self.workspace_id)
        .fetch_one(&mut *self.tx)
        .await?;

        if count <= 1 {
            return Err(Error::Conflict("workspace must retain an owner".into()));
        }

        Ok(())
    }

    async fn own_notification(&mut self, id: Uuid) -> Result<()> {
        sqlx::query(
            "SELECT id FROM notifications WHERE workspace_id=$1 AND id=$2 AND \
            user_id=$3 FOR UPDATE",
        )
        .bind(self.workspace_id)
        .bind(id)
        .bind(self.actor)
        .fetch_optional(&mut *self.tx)
        .await?
        .ok_or(Error::NotFound)?;
        Ok(())
    }

    async fn discussion_lock(&mut self, scope: &str) -> Result<()> {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("{}:{scope}", self.workspace_id))
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

impl Store {
    pub async fn accept_invitation(
        &self,
        workspace_id: Uuid,
        actor: Uuid,
        email: &str,
        token: &str,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let row = sqlx::query(
            "SELECT id,role FROM invitations WHERE workspace_id=$1 AND \
            token_hash=$2 AND lower(email)=lower($3) AND state='pending' AND \
            expires_at>clock_timestamp() FOR UPDATE",
        )
        .bind(workspace_id)
        .bind(crate::auth::hash(token))
        .bind(email)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::BadRequest("invalid or expired invitation".into()))?;
        let id: Uuid = row.try_get("id")?;
        let role: String = row.try_get("role")?;

        let actual: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND \
                lower(email)=lower($2))",
        )
        .bind(actor)
        .bind(email)
        .fetch_one(&mut *tx)
        .await?;

        if !actual {
            return Err(Error::Forbidden);
        }

        sqlx::query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,\
            $2,$3) ON CONFLICT(workspace_id,user_id) DO NOTHING",
        )
        .bind(workspace_id)
        .bind(actor)
        .bind(role)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE invitations SET state='accepted',token_hash='',\
            version=version+1 WHERE workspace_id=$1 AND id=$2",
        )
        .bind(workspace_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        Ok(())
    }
}

fn validate_time(minutes: u32, note: &str) -> Result<()> {
    if minutes == 0 || minutes > 24 * 60 || note.len() > 10_000 {
        return Err(Error::BadRequest(
            "time entry must contain 1 to 1440 minutes".into(),
        ));
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<()> {
    if email.len() > 254
        || email.contains(char::is_whitespace)
        || !email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
    {
        return Err(Error::BadRequest("invalid email".into()));
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<()> {
    if url.len() > 2000
        || !(url.starts_with("https://") || url.starts_with("http://"))
        || url.contains(char::is_whitespace)
    {
        return Err(Error::BadRequest("HTTP or HTTPS URL required".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support as support;
    use serde_json::json;

    async fn command(
        store: &Store,
        workspace: Uuid,
        actor: Uuid,
        value: serde_json::Value,
        expected: BTreeMap<Uuid, i64>,
    ) -> Result<OperationResult> {
        store
            .operation(
                workspace,
                actor,
                serde_json::from_value(value).unwrap(),
                expected,
                None,
                None,
            )
            .await
    }

    #[tokio::test]
    async fn discussion_transactions_preserve_versions_bytes_and_history() {
        let database = support::TestDatabase::new().await;
        let store = Store::connect(&database.url).await.unwrap();
        let mut users = Vec::new();

        for name in ["owner", "member"] {
            users.push(
                store
                    .register(crate::auth::Register {
                        email: format!("{name}@example.com"),
                        password: "discussion-test-password".into(),
                        display_name: name.into(),
                    })
                    .await
                    .unwrap()
                    .profile
                    .id,
            );
        }

        let owner = users[0];
        let member = users[1];
        let workspace = store
            .create_workspace("Discussion".into(), owner)
            .await
            .unwrap();
        let workspace: Uuid = serde_json::from_value(workspace["id"].clone()).unwrap();
        let team = command(
            &store,
            workspace,
            owner,
            json!({"type":"create_team","name":"Team"}),
            BTreeMap::new(),
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
        let issue = command(
            &store,
            workspace,
            owner,
            json!({"type":"create_issue","input":{"title":"Discussion target","team_id":team}}),
            BTreeMap::new(),
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();

        let comment = command(
            &store,
            workspace,
            owner,
            json!({"type":"add_comment","issue_id":issue,"body":"Original"}),
            BTreeMap::new(),
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();

        let version: i64 = sqlx::query_scalar("SELECT version FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(version, 1);
        command(
            &store,
            workspace,
            owner,
            json!({"type":"edit_comment","id":comment,"body":"Edited"}),
            BTreeMap::from([(comment, 1)]),
        )
        .await
        .unwrap();
        assert!(matches!(
            command(
                &store,
                workspace,
                owner,
                json!({"type":"edit_comment","id":comment,"body":"Stale"}),
                BTreeMap::from([(comment, 1)])
            )
            .await,
            Err(Error::Conflict(_))
        ));

        let body: String = sqlx::query_scalar("SELECT body FROM comments WHERE id=$1")
            .bind(comment)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(body, "Edited");
        let time = command(
            &store,
            workspace,
            owner,
            json!({"type":"log_time","issue_id":issue,"minutes":30,"logged_at":Utc::now()}),
            BTreeMap::new(),
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
        command(&store, workspace, owner, json!({"type":"update_time","id":time,"minutes":45,"note":"Revised","logged_at":Utc::now()}), BTreeMap::from([(time, 1)])).await.unwrap();

        let minutes: i64 = sqlx::query_scalar("SELECT minutes FROM time_entries WHERE id=$1")
            .bind(time)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(minutes, 45);

        let attachment_id = Uuid::new_v4();
        let metadata = Attachment {
            id: attachment_id,
            name: "file.txt".into(),
            content_type: "text/plain".into(),
            size: 5,
        };
        let upload = NewAttachment {
            id: attachment_id,
            issue_id: issue,
            uploader_id: owner,
            filename: metadata.name.clone(),
            content_type: metadata.content_type.clone(),
            bytes: b"hello".to_vec(),
        };
        store
            .operation(
                workspace,
                owner,
                Command::AddAttachment {
                    issue_id: issue,
                    attachment: metadata,
                },
                BTreeMap::from([(issue, 1)]),
                None,
                Some(upload),
            )
            .await
            .unwrap();

        let bytes: Vec<u8> = sqlx::query_scalar("SELECT bytes FROM attachments WHERE id=$1")
            .bind(attachment_id)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(bytes, b"hello");
        assert!(matches!(
            command(
                &store,
                workspace,
                owner,
                json!({"type":"remove_attachment","issue_id":issue,"attachment_id":attachment_id}),
                BTreeMap::from([(issue, 1)])
            )
            .await,
            Err(Error::Conflict(_))
        ));
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE id=$1)")
                .bind(attachment_id)
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert!(exists);

        let invitation = command(&store, workspace, owner, json!({"type":"invite","email":"member@example.com","role":"member","token_hash":"ignored"}), BTreeMap::new()).await.unwrap().result.id.unwrap();

        let payload: serde_json::Value = sqlx::query_scalar(
            "SELECT payload FROM jobs WHERE kind='email' AND \
                payload->>'invitation_id'=$1",
        )
        .bind(invitation.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let token = payload["token"].as_str().unwrap();
        store
            .accept_invitation(workspace, member, "member@example.com", token)
            .await
            .unwrap();
        assert!(
            store
                .accept_invitation(workspace, member, "member@example.com", token)
                .await
                .is_err()
        );
        command(
            &store,
            workspace,
            owner,
            json!({"type":"set_team_members","id":team,"members":[owner,member]}),
            BTreeMap::from([(team, 1)]),
        )
        .await
        .unwrap();
        command(
            &store,
            workspace,
            owner,
            json!({"type":"update_issue","id":issue,"patch":{"assignee":member}}),
            BTreeMap::from([(issue, 2)]),
        )
        .await
        .unwrap();
        let member_comment = command(
            &store,
            workspace,
            member,
            json!({"type":"add_comment","issue_id":issue,"body":"Member history"}),
            BTreeMap::new(),
        )
        .await
        .unwrap()
        .result
        .id
        .unwrap();
        let removed = command(
            &store,
            workspace,
            owner,
            json!({"type":"remove_member","user_id":member}),
            BTreeMap::from([(member, 1)]),
        )
        .await
        .unwrap();
        assert_eq!(removed.versions[&issue], 4);
        assert_eq!(removed.versions[&team], 3);

        let assignee: Option<Uuid> = sqlx::query_scalar("SELECT assignee FROM issues WHERE id=$1")
            .bind(issue)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(assignee, None);

        let author: Uuid = sqlx::query_scalar("SELECT author FROM comments WHERE id=$1")
            .bind(member_comment)
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(author, member);

        let joined: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id=$1 AND \
                user_id=$2)",
        )
        .bind(team)
        .bind(member)
        .fetch_one(&store.pool)
        .await
        .unwrap();
        assert!(!joined);
        assert!(matches!(
            command(
                &store,
                workspace,
                owner,
                json!({"type":"remove_member","user_id":owner}),
                BTreeMap::from([(owner, 1)])
            )
            .await,
            Err(Error::Conflict(_))
        ));
        store.pool.close().await;
        database.cleanup().await;
    }
}
