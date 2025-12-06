# Production Readiness TODO

---

## Security & Authentication

### 1. Role-Based Access Control (RBAC)

- Add `role` column to `user_on_team` table with values: `admin`, `member`, `viewer`
- Add `role` column to workspace membership (or create `user_on_workspace` table)
- Implement permission checks in DAL mutations (e.g., only admins can delete teams)
- Create middleware for role-based route protection

### 2. Rate Limiting

- Add rate limiting middleware for all API endpoints
- Implement per-user and per-IP rate limits
- Consider using a library like `hono-rate-limiter` or custom implementation with Redis
- Protect auth endpoints more aggressively (login, register, password reset)

### 3. Audit Logging

- Create `audit_log` table with columns: `id`, `userId`, `action`, `entityType`, `entityId`, `oldValue`, `newValue`, `ipAddress`, `userAgent`, `createdAt`
- Log all create/update/delete operations
- Implement audit log viewer in settings for workspace admins

---

## Core Functionality

### 4. Due Dates & Reminders

- Add `dueDate` column to `issue` table
- Add `reminderAt` column for optional reminders
- Create scheduled job to check for upcoming/overdue issues
- Display overdue indicators in UI

### 5. Issue History / Changelog

- Create `issue_history` table: `id`, `issueId`, `userId`, `field`, `oldValue`, `newValue`, `createdAt`
- Track changes to: status, priority, assignee, summary, description, labels, due date
- Display timeline in issue detail view

### 6. Notifications System

- Create `notification` table: `id`, `userId`, `type`, `title`, `message`, `entityType`, `entityId`, `isRead`, `createdAt`
- Notification types: `assigned`, `mentioned`, `status_changed`, `commented`, `due_soon`, `overdue`
- Implement notification preferences per user
- Add email notifications (optional, using Resend or similar)
- Real-time in-app notifications (consider WebSockets or SSE)

### 7. Keyboard Shortcuts

- Global shortcuts: `c` (create issue), `/` (search), `g t` (go to team)
- Issue list shortcuts: `j/k` (navigate), `x` (select), `s` (change status)
- Issue detail shortcuts: `e` (edit), `a` (assign), `l` (labels), `p` (priority)
- Implement shortcuts help modal (`?`)

---

## Data & Reliability

### 8. Soft Deletes

- Add `deletedAt` column to: `issue`, `team`, `workspace`, `issue_comment`, `label`
- Update all queries to filter out soft-deleted records
- Add restore functionality for admins
- Implement permanent deletion after retention period (e.g., 30 days)

### 9. Database Indexes

Add indexes for frequently queried columns:

```sql
CREATE INDEX idx_issue_status ON issue(status);
CREATE INDEX idx_issue_assigned_to ON issue(assigned_to_id);
CREATE INDEX idx_issue_team ON issue(team_id);
CREATE INDEX idx_issue_workspace ON issue(workspace_id);
CREATE INDEX idx_issue_created_at ON issue(created_at);
CREATE INDEX idx_issue_priority ON issue(priority);
CREATE INDEX idx_issue_comment_issue ON issue_comment(issue_id);
CREATE INDEX idx_label_on_issue_issue ON label_on_issue(issue_id);
```

### 10. Request Validation Middleware

- Centralized input sanitization for all API endpoints
- XSS prevention for user-generated content
- SQL injection protection (already handled by Drizzle, but validate inputs)
- File upload validation (type, size, content)

---

## User Experience

### 11. Activity Feed

- Per-issue activity timeline (status changes, comments, assignments)
- Per-workspace activity feed (recent changes across all teams)
- Personal activity feed (my recent actions)
- Filterable by action type, user, date range

### 12. Bulk Operations

- Multi-select issues in list/board views
- Bulk actions: change status, change assignee, change priority, add label, delete
- Confirmation modal with summary of changes
- Undo support for bulk operations

### 13. Issue Templates

- Create `issue_template` table: `id`, `teamId`, `name`, `summary`, `description`, `priority`, `labels`
- Template selector when creating new issues
- Team admins can manage templates

---

## Infrastructure

### 14. Health Check Endpoint

- Add `/health` endpoint returning server status
- Include checks for: database connection, disk space, memory usage
- Return JSON with status and individual check results
- Use for load balancer health checks and monitoring

### 15. Structured Logging

- Replace console.log with structured JSON logging
- Include: timestamp, level, message, requestId, userId, path, duration
- Add request ID middleware for tracing
- Log format compatible with log aggregators (Datadog, Loki, etc.)

### 16. Error Tracking Integration

- Integrate Sentry or similar error tracking service
- Capture unhandled exceptions with context
- Track performance (slow queries, slow API responses)
- Set up alerts for error rate spikes

---

## Additional Considerations

### Performance

- [ ] Implement pagination for all list endpoints
- [ ] Add caching layer for frequently accessed data (workspace settings, team info)
- [ ] Optimize N+1 queries in issue lists with labels/assignees

### Testing

- [ ] Add integration tests for critical paths (auth, issue CRUD)
- [ ] Add E2E tests for main user flows
- [ ] Set up CI/CD pipeline with test runs

### Documentation

- [ ] API documentation (OpenAPI/Swagger)
- [ ] User guide / help documentation
- [ ] Admin/deployment guide

### Observability

- [ ] Request duration metrics
- [ ] Database query metrics
- [ ] User activity analytics
- [ ] Error rate dashboards
