use super::super::*;
use super::find_mut;

impl Workspace {
    pub(super) fn apply_discussion(
        &mut self,
        actor: Uuid,
        command: Command,
        now: DateTime<Utc>,
    ) -> Result<Option<Uuid>> {
        let id = match command {
            Command::AddAttachment {
                issue_id,
                attachment,
            } => {
                validate_attachment(&attachment)?;
                self.issue_mut(issue_id)?.attachments.push(attachment);
                issue_id
            }
            Command::AttachCommentFile {
                comment_id,
                attachment,
            } => {
                validate_attachment(&attachment)?;
                let comment = find(&self.comments, |c| c.id == comment_id)?;
                self.issue(comment.issue_id)?;
                self.author_or_admin(actor, comment.author)?;
                find_mut(&mut self.comments, |c| c.id == comment_id)?
                    .attachments
                    .push(attachment);
                comment_id
            }
            Command::RemoveAttachment {
                issue_id,
                attachment_id,
            } => {
                let issue = self.issue_mut(issue_id)?;
                if !issue.attachments.iter().any(|a| a.id == attachment_id) {
                    return Err(Error::NotFound);
                }
                issue.attachments.retain(|a| a.id != attachment_id);
                issue_id
            }
            Command::AddComment {
                id,
                issue_id,
                body,
                mentions,
                attachments,
            } => self.add_comment(actor, id, issue_id, body, mentions, attachments, now)?,
            Command::EditComment { id, body, mentions } => {
                text(&body, 100_000)?;
                for user in &mentions {
                    self.member(*user)?;
                }
                let author = find(&self.comments, |c| c.id == id)?.author;
                self.author_or_admin(actor, author)?;
                let comment = find_mut(&mut self.comments, |c| c.id == id)?;
                comment.body = body;
                comment.mentions = mentions;
                comment.edited_at = Some(now);
                id
            }
            Command::DeleteComment { id } => {
                let author = find(&self.comments, |c| c.id == id)?.author;
                self.author_or_admin(actor, author)?;
                self.comments.retain(|c| c.id != id);
                id
            }
            Command::LogTime {
                id,
                issue_id,
                minutes,
                note,
                logged_at,
            } => {
                self.issue(issue_id)?;
                validate_time(minutes, &note)?;
                timestamp(logged_at)?;
                let id = self.take_client_id(id)?;
                self.time_entries.push(TimeEntry {
                    version: 1,
                    id,
                    issue_id,
                    user_id: actor,
                    minutes,
                    note,
                    logged_at,
                });
                id
            }
            Command::UpdateTime {
                id,
                minutes,
                note,
                logged_at,
            } => {
                validate_time(minutes, &note)?;
                timestamp(logged_at)?;
                let owner = find(&self.time_entries, |e| e.id == id)?.user_id;
                self.author_or_admin(actor, owner)?;
                let entry = find_mut(&mut self.time_entries, |e| e.id == id)?;
                entry.minutes = minutes;
                entry.note = note;
                entry.logged_at = logged_at;
                id
            }
            Command::DeleteTime { id } => {
                let owner = find(&self.time_entries, |e| e.id == id)?.user_id;
                self.author_or_admin(actor, owner)?;
                self.time_entries.retain(|e| e.id != id);
                id
            }
            Command::SaveView {
                id,
                name,
                shared,
                filter,
            } => {
                text(&name, 200)?;
                filter.validate()?;
                let id = self.take_client_id(id)?;
                self.views.push(SavedView {
                    version: 1,
                    id,
                    owner: actor,
                    name,
                    shared,
                    filter,
                });
                id
            }
            Command::UpdateView {
                id,
                name,
                shared,
                filter,
            } => {
                text(&name, 200)?;
                filter.validate()?;
                let owner = find(&self.views, |v| v.id == id)?.owner;
                self.author_or_admin(actor, owner)?;
                if shared && self.member(actor)?.role == Role::Viewer {
                    return Err(Error::Forbidden);
                }
                let view = find_mut(&mut self.views, |v| v.id == id)?;
                view.name = name;
                view.shared = shared;
                view.filter = filter;
                id
            }
            Command::DeleteView { id } => {
                let owner = find(&self.views, |v| v.id == id)?.owner;
                self.author_or_admin(actor, owner)?;
                self.views.retain(|v| v.id != id);
                id
            }
            Command::Invite {
                email,
                role,
                token_hash,
            } => self.invite(actor, email, role, token_hash, now)?,
            Command::ResendInvitation { id, token_hash } => {
                self.admin(actor)?;
                validate_hash(&token_hash)?;
                let invitation = find_mut(&mut self.invitations, |i| i.id == id)?;
                if matches!(
                    invitation.state,
                    InvitationState::Accepted | InvitationState::Cancelled
                ) {
                    return Err(Error::Conflict("invitation is no longer pending".into()));
                }
                invitation.token_hash = token_hash;
                invitation.expires_at = now + chrono::Duration::days(7);
                invitation.state = InvitationState::Pending;
                id
            }
            Command::CancelInvitation { id } => {
                self.admin(actor)?;
                let invitation = find_mut(&mut self.invitations, |i| i.id == id)?;
                if invitation.state == InvitationState::Accepted {
                    return Err(Error::Conflict("invitation already accepted".into()));
                }
                invitation.state = InvitationState::Cancelled;
                invitation.token_hash.clear();
                id
            }
            Command::SetRole { user_id, role } => {
                self.set_role(actor, user_id, role)?;
                user_id
            }
            Command::RemoveMember { user_id } => {
                self.remove_member(actor, user_id)?;
                user_id
            }
            Command::MarkNotificationRead { id, created_at } => {
                let notification = self.own_notification(actor, id)?;
                if notification.read_at.is_none()
                    && created_at.is_none_or(|seen| seen == notification.created_at)
                {
                    notification.read_at = Some(now);
                }
                id
            }
            Command::MarkNotificationUnread { id } => {
                self.own_notification(actor, id)?.read_at = None;
                id
            }
            Command::MarkAllNotificationsRead { notifications } => {
                for n in self.notifications.iter_mut().filter(|n| {
                    n.user_id == actor
                        && n.read_at.is_none()
                        && notifications.as_ref().is_none_or(|seen| {
                            seen.iter()
                                .any(|seen| seen.id == n.id && seen.created_at == n.created_at)
                        })
                }) {
                    n.read_at = Some(now)
                }
                return Ok(None);
            }
            Command::ConfigureAlerts {
                assignment,
                reply,
                change,
                mention,
                deadline,
            } => {
                self.alert_preferences.retain(|p| p.user_id != actor);
                self.alert_preferences.push(AlertPreferences {
                    version: 1,
                    user_id: actor,
                    assignment,
                    reply,
                    change,
                    mention,
                    deadline,
                });
                return Ok(None);
            }
            Command::CreateIntegration {
                id,
                name,
                webhook_url,
                secret,
                events,
            } => {
                self.admin(actor)?;
                text(&name, 200)?;
                validate_url(&webhook_url)?;
                text(&secret, 4096)?;
                validate_webhook_events(&events)?;
                let id = self.take_client_id(id)?;
                self.integrations.push(Integration {
                    version: 1,
                    id,
                    name,
                    webhook_url,
                    secret,
                    enabled: true,
                    events,
                });
                id
            }
            Command::UpdateIntegration {
                id,
                enabled,
                events,
            } => {
                self.admin(actor)?;
                if let Some(events) = &events {
                    validate_webhook_events(events)?;
                }
                let integration = find_mut(&mut self.integrations, |i| i.id == id)?;
                integration.enabled = enabled;
                if let Some(events) = events {
                    integration.events = events;
                }
                id
            }
            Command::DeleteIntegration { id } => {
                self.admin(actor)?;
                if !self.integrations.iter().any(|i| i.id == id) {
                    return Err(Error::NotFound);
                }
                self.integrations.retain(|i| i.id != id);
                id
            }
            _ => unreachable!("not a discussion command"),
        };
        Ok(Some(id))
    }

    fn author_or_admin(&self, actor: Uuid, author: Uuid) -> Result<()> {
        if author == actor {
            Ok(())
        } else {
            self.admin(actor)
        }
    }

    fn own_notification(&mut self, actor: Uuid, id: Uuid) -> Result<&mut Notification> {
        find_mut(&mut self.notifications, |n| {
            n.id == id && n.user_id == actor
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn add_comment(
        &mut self,
        actor: Uuid,
        id: Option<Uuid>,
        issue_id: Uuid,
        body: String,
        mentions: Vec<Uuid>,
        attachments: Vec<Attachment>,
        now: DateTime<Utc>,
    ) -> Result<Uuid> {
        self.issue(issue_id)?;
        text(&body, 100_000)?;
        for user in &mentions {
            self.member(*user)?;
        }
        for attachment in &attachments {
            validate_attachment(attachment)?;
        }

        let id = self.take_client_id(id)?;
        let followers = self.issue(issue_id)?.followers.clone();
        let alerts = followers
            .into_iter()
            .map(|user| (user, AlertKind::Reply, format!("reply:{id}:{user}")))
            .chain(
                mentions
                    .iter()
                    .map(|user| (*user, AlertKind::Mention, format!("mention:{id}:{user}"))),
            );
        for (user, kind, key) in alerts.collect::<Vec<_>>() {
            if user != actor {
                self.notify(user, Some(issue_id), kind, body.clone(), key, now)
            }
        }

        self.comments.push(Comment {
            version: 1,
            id,
            issue_id,
            author: actor,
            body,
            mentions,
            attachments,
            created_at: now,
            edited_at: None,
            tracker: None,
            via: None,
        });
        Ok(id)
    }

    fn invite(
        &mut self,
        actor: Uuid,
        email: String,
        role: Role,
        token_hash: String,
        now: DateTime<Utc>,
    ) -> Result<Uuid> {
        self.admin(actor)?;
        if role == Role::Owner && self.member(actor)?.role != Role::Owner {
            return Err(Error::Forbidden);
        }
        validate_email(&email)?;
        validate_hash(&token_hash)?;
        if self.invitations.iter().any(|i| {
            i.email.eq_ignore_ascii_case(&email)
                && i.state == InvitationState::Pending
                && i.expires_at > now
        }) {
            return Err(Error::Conflict("invitation already pending".into()));
        }

        let id = Uuid::new_v4();
        self.invitations.push(Invitation {
            version: 1,
            id,
            email: email.to_lowercase(),
            role,
            token_hash,
            expires_at: now + chrono::Duration::days(7),
            state: InvitationState::Pending,
        });
        Ok(id)
    }

    fn sole_owner(&self) -> bool {
        self.members
            .iter()
            .filter(|m| m.role == Role::Owner)
            .count()
            == 1
    }

    fn set_role(&mut self, actor: Uuid, user_id: Uuid, role: Role) -> Result<()> {
        self.admin(actor)?;
        let old = self.member(user_id)?.role.clone();
        if (old == Role::Owner || role == Role::Owner) && self.member(actor)?.role != Role::Owner {
            return Err(Error::Forbidden);
        }
        if old == Role::Owner && role != Role::Owner && self.sole_owner() {
            return Err(Error::Conflict("workspace must retain an owner".into()));
        }

        find_mut(&mut self.members, |m| m.user_id == user_id)?.role = role;
        Ok(())
    }

    fn remove_member(&mut self, actor: Uuid, user_id: Uuid) -> Result<()> {
        self.admin(actor)?;
        if self.member(user_id)?.role == Role::Owner {
            if self.member(actor)?.role != Role::Owner {
                return Err(Error::Forbidden);
            }
            if self.sole_owner() {
                return Err(Error::Conflict("workspace must retain an owner".into()));
            }
        }

        self.members.retain(|m| m.user_id != user_id);
        for team in &mut self.teams {
            team.members.retain(|u| *u != user_id);
        }
        for issue in &mut self.issues {
            if issue.assignee == Some(user_id) {
                issue.assignee = None
            }
            issue.followers.retain(|u| *u != user_id);
        }
        Ok(())
    }
}

fn find<T>(items: &[T], matches: impl Fn(&T) -> bool) -> Result<&T> {
    items
        .iter()
        .find(|item| matches(item))
        .ok_or(Error::NotFound)
}

pub(super) fn validate_attachment(a: &Attachment) -> Result<()> {
    text(&a.name, 500)?;
    if a.size > 25 * 1024 * 1024 || a.content_type.len() > 200 {
        return Err(Error::BadRequest("attachment exceeds limits".into()));
    }
    Ok(())
}

pub(super) fn validate_time(minutes: u32, note: &str) -> Result<()> {
    if minutes == 0 || minutes > 24 * 60 || note.len() > 10_000 {
        return Err(Error::BadRequest(
            "time entry must contain 1 to 1440 minutes".into(),
        ));
    }
    Ok(())
}

fn validate_hash(hash: &str) -> Result<()> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Err(Error::BadRequest("token hash must be SHA-256 hex".into()))
    } else {
        Ok(())
    }
}
