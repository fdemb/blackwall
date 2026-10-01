import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  layout("routes/auth-layout.tsx", [
    route("login", "routes/login.tsx"),
    route("register", "routes/register.tsx"),
    route("recover", "routes/recover.tsx"),
  ]),
  layout("routes/authed.tsx", [
    route("welcome", "routes/welcome.tsx"),
    route(":ws", "routes/workspace.tsx", [
      index("routes/ws-index.tsx"),
      route("my-issues", "routes/my-issues.tsx"),
      route("issues", "routes/issues.tsx"),
      route("views/:viewId", "routes/view.tsx"),
      route("team/:teamId", "routes/team.tsx"),
      route("team/:teamId/sprints", "routes/sprints.tsx"),
      route("issue/:issueId", "routes/issue.tsx"),
      route("projects", "routes/projects.tsx"),
      route("projects/:projectId", "routes/project.tsx"),
      route("inbox", "routes/inbox.tsx"),
      route("reports", "routes/reports.tsx"),
      route("people", "routes/people.tsx"),
      route("people/:userId", "routes/person.tsx"),
      route("trash", "routes/trash.tsx"),
      route("account", "routes/account.tsx"),
      route("settings", "routes/settings.tsx", [
        index("routes/settings-general.tsx"),
        route("members", "routes/settings-members.tsx"),
        route("teams", "routes/settings-teams.tsx"),
        route("labels", "routes/settings-labels.tsx"),
        route("integrations", "routes/settings-integrations.tsx"),
        route("data", "routes/settings-data.tsx"),
      ]),
    ]),
  ]),
] satisfies RouteConfig;
