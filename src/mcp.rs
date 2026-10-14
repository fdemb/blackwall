//! A Model Context Protocol server at `/mcp`, using the stateless Streamable HTTP
//! transport: each POST carries one JSON-RPC message and gets one JSON reply.
//! It authenticates like `/api/v1` and its tools call the same functions, so a
//! token's access, workspace allowlist and rate limit apply unchanged.

use crate::{
    api::{
        self, Access, ApiActor, ApiIssue, IssueQuery, PageParams, Scope, WriteOptions,
        directory::Directory,
        issues::{self, CreateComment, CreateIssue, UpdateComment, UpdateIssue},
        resources,
    },
    domain::{Command, Project, SprintState},
    error::{Error, Result},
    store::Store,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{sync::OnceLock, time::Duration};
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

/// Newest first; the first is offered when the client asks for an unknown version.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

const INSTRUCTIONS: &str = "Blackwall is a work tracker. Issues belong to a team and sit in one of \
the team's stages; keys look like ENG-42 (team key, then number) and are accepted wherever an issue \
is named. Tools take names wherever they take ids: a team by key or name, a stage, label, project, \
milestone or sprint by name, a person by email, display name or \"me\". Responses name every \
record they point at. get_workspace_overview lists the names to choose from. When the token \
reaches a single workspace, workspace_id may be omitted. Everything you write is shown as the \
token's user acting through this token, so people can tell your changes from theirs.";

pub async fn handle(State(store): State<Store>, actor: ApiActor, body: Bytes) -> Response {
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(rpc_error(Value::Null, -32700, "parse error")),
            )
                .into_response();
        }
    };
    if !message.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(rpc_error(
                Value::Null,
                -32600,
                "send one JSON-RPC message per request",
            )),
        )
            .into_response();
    }

    // Notifications and responses need no reply.
    let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id").cloned()) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let params = &message["params"];
    let result = match method {
        "initialize" => Ok(initialize(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools(&actor) })),
        "tools/call" => call(&store, &actor, params).await,
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Json(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => rpc_error(id, code, &message),
    })
    .into_response()
}

/// Rejects browser requests from origins outside `MCP_ALLOWED_ORIGINS`, as
/// the transport requires against DNS rebinding. Requests without an `Origin`
/// (desktop and server clients) and same-origin requests pass.
pub async fn guard_origin(request: Request, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) && !allowed_origin(request.headers()) {
        return Error::Denied("origin not allowed; see MCP_ALLOWED_ORIGINS".into()).into_response();
    }
    next.run(request).await
}

fn allowed_origin(headers: &HeaderMap) -> bool {
    static ALLOWED: OnceLock<Vec<String>> = OnceLock::new();
    let allowed = ALLOWED.get_or_init(|| {
        std::env::var("MCP_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|origin| origin.trim().trim_end_matches('/').to_ascii_lowercase())
            .filter(|origin| !origin.is_empty())
            .collect()
    });
    if !crate::http::cross_origin(headers) {
        return true;
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    allowed.iter().any(|a| a == "*" || *a == origin)
}

/// CORS for the origins `guard_origin` admits; credentials are never allowed.
pub fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|_, parts| {
            allowed_origin(&parts.headers)
        }))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("mcp-protocol-version"),
            HeaderName::from_static("mcp-session-id"),
            HeaderName::from_static("last-event-id"),
        ])
        .expose_headers(api::EXPOSED_HEADERS)
        .max_age(Duration::from_secs(600))
}

/// The transport's optional server-to-client stream, which this server does not offer.
pub async fn stream() -> Response {
    let mut response = StatusCode::METHOD_NOT_ALLOWED.into_response();
    response
        .headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    response
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn initialize(params: &Value) -> Value {
    let requested = params["protocolVersion"].as_str().unwrap_or_default();
    let version = PROTOCOL_VERSIONS
        .iter()
        .find(|v| **v == requested)
        .unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "blackwall", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

struct Tool {
    name: &'static str,
    description: &'static str,
    /// The token access a tool needs.
    access: Access,
    /// Removes something, even if it can be restored.
    destructive: bool,
    schema: fn() -> Value,
}

const TOOLS: &[Tool] = &[
    Tool {
        name: "list_workspaces",
        description: "List the workspaces this token can reach, with the user's role in each.",
        access: Access::Read,
        destructive: false,
        schema: || object(json!({}), &[]),
    },
    Tool {
        name: "get_workspace_overview",
        description: "The token's user, teams with their stages, labels, projects with their \
            milestones, open sprints and members: the names and ids other tools take.",
        access: Access::Read,
        destructive: false,
        schema: || object(json!({ "workspace_id": workspace_id() }), &[]),
    },
    Tool {
        name: "search_issues",
        description: "Find issues by text and filters. Returns the total number of matches and \
            a page of compact issues with names instead of ids and the start of each description. \
            Use get_issue for everything else.",
        access: Access::Read,
        destructive: false,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "query": { "type": "string", "description": "Text, or an issue number or key." },
                    "where": where_schema(),
                    "archived": { "type": "boolean", "description": "Search archived issues instead of live ones." },
                    "trash": { "type": "boolean", "description": "Search trashed issues instead of live ones." },
                    "sort": {
                        "type": "string",
                        "enum": ["position", "deadline", "updated", "priority"],
                        "description": "Defaults to position, the board order."
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "Defaults to 25." },
                    "cursor": { "type": "string", "description": "next_cursor from a previous call." },
                    "include_description": {
                        "type": "boolean",
                        "description": "Return whole descriptions instead of their first 200 characters."
                    }
                }),
                &[],
            )
        },
    },
    Tool {
        name: "get_issue",
        description: "An issue with every field named, and its first 20 comments. Page through \
            the rest with list_comments.",
        access: Access::Read,
        destructive: false,
        schema: || {
            object(
                json!({ "workspace_id": workspace_id(), "issue": issue_ref() }),
                &["issue"],
            )
        },
    },
    Tool {
        name: "list_comments",
        description: "An issue's comments, oldest first, with each author and the token that \
            wrote it for them, if any.",
        access: Access::Read,
        destructive: false,
        schema: || {
            let mut properties = page_fields();
            properties["workspace_id"] = workspace_id();
            properties["issue"] = issue_ref();
            object(properties, &["issue"])
        },
    },
    Tool {
        name: "get_issue_history",
        description: "An issue's activity, newest first: who did what, which fields changed, and \
            the token that acted for them, if any.",
        access: Access::Read,
        destructive: false,
        schema: || {
            let mut properties = page_fields();
            properties["workspace_id"] = workspace_id();
            properties["issue"] = issue_ref();
            object(properties, &["issue"])
        },
    },
    Tool {
        name: "list_projects",
        description: "Projects with their descriptions, teams and milestones.",
        access: Access::Read,
        destructive: false,
        schema: || {
            let mut properties = page_fields();
            properties["workspace_id"] = workspace_id();
            object(properties, &[])
        },
    },
    Tool {
        name: "list_sprints",
        description: "Sprints with their goals and dates, oldest first. Without state, lists \
            planned and active sprints.",
        access: Access::Read,
        destructive: false,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "team": { "type": "string", "description": "Team key, name or UUID." },
                    "state": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["planned", "active", "completed", "archived"] }
                    }
                }),
                &[],
            )
        },
    },
    Tool {
        name: "create_issue",
        description: "Create an issue in a team. Without a stage it lands in the team's first \
            stage. Returns the issue as get_issue does.",
        access: Access::Write,
        destructive: false,
        schema: || {
            let mut properties = issue_fields();
            properties["workspace_id"] = workspace_id();
            properties["team"] =
                json!({ "type": "string", "description": "Team key, name or UUID." });
            properties["dependencies"] = json!({
                "type": "array", "items": { "type": "string" },
                "description": "Keys or UUIDs of issues this one depends on."
            });
            object(properties, &["team", "title"])
        },
    },
    Tool {
        name: "update_issue",
        description: "Change an issue's fields. Omitted fields stay; null clears assignee, \
            estimate, deadline, project, milestone, sprint or parent. labels replaces the whole \
            set ([] removes every label); add_labels and remove_labels change only those named. \
            Returns the updated issue.",
        access: Access::Write,
        destructive: false,
        schema: || {
            let mut properties = issue_fields();
            properties["workspace_id"] = workspace_id();
            properties["issue"] = issue_ref();
            properties["labels"]["description"] =
                json!("Replaces every label with these names or UUIDs; [] removes them all.");
            properties["add_labels"] = json!({
                "type": "array", "items": { "type": "string" },
                "description": "Label names or UUIDs to add, keeping the rest."
            });
            properties["remove_labels"] = json!({
                "type": "array", "items": { "type": "string" },
                "description": "Label names or UUIDs to remove, keeping the rest."
            });
            properties["dependencies"] = json!({
                "type": "array", "items": { "type": "string" },
                "description": "Replaces the issues this one depends on, by key or UUID."
            });
            object(properties, &["issue"])
        },
    },
    Tool {
        name: "delete_issue",
        description: "Move an issue to the trash. restore_issue brings it back.",
        access: Access::Write,
        destructive: true,
        schema: issue_only,
    },
    Tool {
        name: "restore_issue",
        description: "Bring an issue back from the trash.",
        access: Access::Write,
        destructive: false,
        schema: issue_only,
    },
    Tool {
        name: "archive_issue",
        description: "Archive an issue in a done stage, hiding it from boards and searches.",
        access: Access::Write,
        destructive: false,
        schema: issue_only,
    },
    Tool {
        name: "unarchive_issue",
        description: "Return an archived issue to boards and searches.",
        access: Access::Write,
        destructive: false,
        schema: issue_only,
    },
    Tool {
        name: "add_comment",
        description: "Comment on an issue. The comment shows the token's user as its author and \
            this token as the one that wrote it.",
        access: Access::Comment,
        destructive: false,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "issue": issue_ref(),
                    "body": { "type": "string", "description": "Markdown." },
                    "mentions": mentions()
                }),
                &["issue", "body"],
            )
        },
    },
    Tool {
        name: "edit_comment",
        description: "Replace a comment's text. Authors may edit their own comments; \
            administrators may edit any.",
        access: Access::Comment,
        destructive: false,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "comment_id": { "type": "string", "format": "uuid" },
                    "body": { "type": "string", "description": "Markdown." },
                    "mentions": mentions()
                }),
                &["comment_id", "body"],
            )
        },
    },
    Tool {
        name: "delete_comment",
        description: "Delete a comment for good.",
        access: Access::Comment,
        destructive: true,
        schema: || {
            object(
                json!({
                    "workspace_id": workspace_id(),
                    "comment_id": { "type": "string", "format": "uuid" }
                }),
                &["comment_id"],
            )
        },
    },
];

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn workspace_id() -> Value {
    json!({
        "type": "string",
        "format": "uuid",
        "description": "Optional when the token reaches a single workspace."
    })
}

fn issue_ref() -> Value {
    json!({ "type": "string", "description": "Issue key such as ENG-42, or its UUID." })
}

fn issue_only() -> Value {
    object(
        json!({ "workspace_id": workspace_id(), "issue": issue_ref() }),
        &["issue"],
    )
}

fn mentions() -> Value {
    json!({
        "type": "array",
        "items": { "type": "string" },
        "description": "People to notify: emails, display names or UUIDs."
    })
}

fn page_fields() -> Value {
    json!({
        "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Defaults to 50." },
        "cursor": { "type": "string", "description": "next_cursor from a previous call." }
    })
}

fn where_schema() -> Value {
    json!({
        "type": "array",
        "description": "Filter clauses; every clause must hold. In one clause the values are \
            alternatives: is matches a field equal to any value, is_not one equal to none. \
            Values by field: \
            assignee, created_by: email, display name, \"me\" or user UUID; null = unassigned. \
            team: key, name or UUID. \
            stage: name or UUID; a name matches that stage in every team. \
            stage_kind: backlog, planned, active, done or cancelled; is_not [done, cancelled] means open. \
            priority: none < low < normal < high < urgent. \
            label: name or UUID; is matches issues with any of them; null = no labels. \
            project, sprint: name or UUID; null = none. \
            parent: issue key or UUID; null = top-level. \
            dependencies: issue key or UUID; null = no dependencies. \
            estimate: whole number as a string; null = no estimate. \
            deadline, created_at, updated_at: RFC 3339 timestamp with offset, or a relative day \
            such as +0d (end of today, UTC), +7d or -30d; deadline null = no deadline. \
            lt, lte, gt and gte work on priority, estimate and the dates, take exactly one \
            non-null value and never match an empty field. At most 32 clauses of 1 to 200 values.",
        "items": {
            "type": "object",
            "properties": {
                "field": {
                    "type": "string",
                    "enum": [
                        "assignee", "created_by", "team", "stage", "stage_kind", "priority",
                        "label", "project", "sprint", "parent", "dependencies", "estimate",
                        "deadline", "created_at", "updated_at"
                    ]
                },
                "op": { "type": "string", "enum": ["is", "is_not", "lt", "lte", "gt", "gte"] },
                "values": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": ["string", "null"] }
                }
            },
            "required": ["field", "op", "values"]
        },
        "examples": [[
            { "field": "assignee", "op": "is", "values": ["me"] },
            { "field": "stage_kind", "op": "is_not", "values": ["done", "cancelled"] },
            { "field": "deadline", "op": "lte", "values": ["+7d"] }
        ]]
    })
}

fn issue_fields() -> Value {
    let reference =
        |description: &str| json!({ "type": ["string", "null"], "description": description });
    json!({
        "title": { "type": "string" },
        "description": { "type": "string", "description": "Markdown." },
        "stage": { "type": "string", "description": "Stage name in the issue's team, or its UUID." },
        "assignee": reference("Email, display name, \"me\" or user UUID."),
        "priority": { "type": "string", "enum": ["none", "low", "normal", "high", "urgent"] },
        "labels": { "type": "array", "items": { "type": "string" }, "description": "Label names or UUIDs." },
        "estimate": { "type": ["integer", "null"], "minimum": 0, "description": "Points." },
        "deadline": {
            "type": ["string", "null"],
            "format": "date-time",
            "description": "RFC 3339 timestamp with offset, such as 2026-10-21T17:00:00Z."
        },
        "project": reference("Project name or UUID."),
        "milestone": reference("Milestone name or UUID, within the issue's project."),
        "sprint": reference("Sprint name, number (12 or #12) or UUID, within the issue's team."),
        "parent": reference("Parent issue key or UUID.")
    })
}

fn allowed(actor: &ApiActor, tool: &Tool) -> bool {
    match tool.access {
        Access::Read => true,
        Access::Comment => actor.0.access != Access::Read,
        Access::Write => actor.0.access == Access::Write,
    }
}

fn tools(actor: &ApiActor) -> Vec<Value> {
    TOOLS
        .iter()
        .filter(|tool| allowed(actor, tool))
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.schema)(),
                "annotations": {
                    "readOnlyHint": tool.access == Access::Read,
                    "destructiveHint": tool.destructive,
                    "openWorldHint": false
                }
            })
        })
        .collect()
}

async fn call(
    store: &Store,
    actor: &ApiActor,
    params: &Value,
) -> std::result::Result<Value, (i64, String)> {
    let name = params["name"].as_str().unwrap_or_default();
    if !TOOLS.iter().any(|tool| tool.name == name) {
        return Err((-32602, format!("unknown tool: {name}")));
    }
    let arguments = match &params["arguments"] {
        Value::Object(arguments) => arguments.clone(),
        Value::Null => Map::new(),
        _ => return Err((-32602, "arguments must be an object".into())),
    };

    // Tool failures are results the model can read and act on, not protocol errors.
    Ok(match run_tool(store, actor, name, arguments).await {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false
        }),
        Err(error) => {
            let message = match &error {
                Error::Database(_) | Error::Internal(_) => {
                    tracing::error!(%error, tool = name, "MCP tool failed");
                    "internal server error".to_owned()
                }
                _ => error.to_string(),
            };
            json!({ "content": [{ "type": "text", "text": message }], "isError": true })
        }
    })
}

async fn run_tool(
    store: &Store,
    actor: &ApiActor,
    name: &str,
    mut args: Map<String, Value>,
) -> Result<Value> {
    if name == "list_workspaces" {
        return Ok(json!({ "workspaces": resources::workspace_list(store, actor).await? }));
    }
    let workspace = workspace(store, actor, args.remove("workspace_id")).await?;
    let access = TOOLS
        .iter()
        .find(|tool| tool.name == name)
        .map_or(Access::Write, |tool| tool.access);
    match access {
        Access::Read => read_tool(store, actor.read(workspace)?, name, args).await,
        Access::Comment => write_tool(store, actor.comment(workspace)?, name, args).await,
        Access::Write => write_tool(store, actor.write(workspace)?, name, args).await,
    }
}

async fn read_tool(
    store: &Store,
    scope: Scope,
    name: &str,
    mut args: Map<String, Value>,
) -> Result<Value> {
    match name {
        "get_workspace_overview" => overview(store, scope).await,
        "search_issues" => {
            let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(25);
            if !(1..=100).contains(&limit) {
                return Err(Error::BadRequest("limit must be between 1 and 100".into()));
            }
            args.insert("limit".into(), json!(limit));
            if let Some(query) = args.remove("query") {
                args.insert("search".into(), query);
            }
            let full = args
                .remove("include_description")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let query: IssueQuery = from_args(args)?;
            let page = issues::search(store, scope, query).await?;
            let compact: Vec<Value> = page.data.iter().map(|i| compact_issue(i, full)).collect();
            Ok(json!({ "total": page.total, "issues": compact, "next_cursor": page.next_cursor }))
        }
        "get_issue" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let issue = issues::fetch(store, scope, id).await?;
            let comments = issues::issue_comments(store, scope, id, &first(20)).await?;
            Ok(json!({
                "issue": issue,
                "comments": comments.data,
                "comments_next_cursor": comments.next_cursor,
            }))
        }
        "list_comments" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let page = issues::issue_comments(store, scope, id, &from_args(args)?).await?;
            Ok(json!({ "comments": page.data, "next_cursor": page.next_cursor }))
        }
        "get_issue_history" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let page = issues::issue_activity(store, scope, id, &from_args(args)?).await?;
            Ok(json!({ "activity": page.data, "next_cursor": page.next_cursor }))
        }
        "list_projects" => projects(store, scope, &from_args(args)?).await,
        "list_sprints" => sprints(store, scope, args).await,
        _ => Err(Error::NotFound),
    }
}

async fn write_tool(
    store: &Store,
    scope: Scope,
    name: &str,
    mut args: Map<String, Value>,
) -> Result<Value> {
    match name {
        "create_issue" => {
            let input: CreateIssue = from_args(args)?;
            let issue = issues::create_issue(store, scope, input, WriteOptions::default()).await?;
            Ok(json!({ "issue": issue }))
        }
        "update_issue" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let update: UpdateIssue = from_args(args)?;
            let issue =
                issues::update_issue(store, scope, id, update, WriteOptions::default()).await?;
            Ok(json!({ "issue": issue }))
        }
        "delete_issue" | "restore_issue" | "archive_issue" | "unarchive_issue" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let command = match name {
                "delete_issue" => Command::DeleteIssue { id },
                "restore_issue" => Command::RestoreIssue { id },
                "archive_issue" => Command::ArchiveIssue { id },
                _ => Command::UnarchiveIssue { id },
            };
            issues::transition_issue(store, scope, id, command, WriteOptions::default()).await?;
            Ok(json!({ "issue": issues::fetch(store, scope, id).await? }))
        }
        "add_comment" => {
            let id = issue_arg(store, scope, &mut args).await?;
            let body: CreateComment = from_args(args)?;
            let comment =
                issues::add_comment(store, scope, id, body, WriteOptions::default()).await?;
            Ok(json!({ "comment": comment }))
        }
        "edit_comment" => {
            let id = comment_arg(&mut args)?;
            let body: UpdateComment = from_args(args)?;
            let comment =
                issues::edit_comment(store, scope, id, body, WriteOptions::default()).await?;
            Ok(json!({ "comment": comment }))
        }
        "delete_comment" => {
            let id = comment_arg(&mut args)?;
            issues::remove_comment(store, scope, id, WriteOptions::default()).await?;
            Ok(json!({ "deleted": id }))
        }
        _ => Err(Error::NotFound),
    }
}

fn first(limit: i64) -> PageParams {
    PageParams {
        limit: Some(limit),
        cursor: None,
    }
}

fn from_args<T: serde::de::DeserializeOwned>(args: Map<String, Value>) -> Result<T> {
    serde_json::from_value(Value::Object(args))
        .map_err(|error| Error::BadRequest(format!("invalid arguments: {error}")))
}

/// The named workspace, or the only one the token reaches.
async fn workspace(store: &Store, actor: &ApiActor, named: Option<Value>) -> Result<Uuid> {
    if let Some(named) = named.filter(|v| !v.is_null()) {
        return named
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(|| Error::BadRequest("workspace_id must be a UUID".into()));
    }
    let mut reachable = resources::workspace_list(store, actor).await?;
    match (reachable.pop(), reachable.is_empty()) {
        (Some(only), true) => Ok(only.id),
        (None, _) => Err(Error::BadRequest("this token reaches no workspaces".into())),
        _ => Err(Error::BadRequest(
            "workspace_id is required; call list_workspaces".into(),
        )),
    }
}

async fn issue_arg(store: &Store, scope: Scope, args: &mut Map<String, Value>) -> Result<Uuid> {
    let reference = args
        .remove("issue")
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| Error::BadRequest("issue is required".into()))?;
    issues::resolve(store, scope, &reference).await
}

fn comment_arg(args: &mut Map<String, Value>) -> Result<Uuid> {
    args.remove("comment_id")
        .and_then(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()))
        .ok_or_else(|| Error::BadRequest("comment_id must be a comment's UUID".into()))
}

/// What a search result needs to pick an issue: names instead of ids, and the start of
/// the description unless `full` asks for all of it.
fn compact_issue(issue: &ApiIssue, full: bool) -> Value {
    let description = if full || issue.description.chars().count() <= 200 {
        issue.description.clone()
    } else {
        let mut start: String = issue.description.chars().take(200).collect();
        start.push('…');
        start
    };
    json!({
        "key": issue.key,
        "id": issue.id,
        "title": issue.title,
        "description": description,
        "team": issue.team.key,
        "stage": { "name": issue.stage.name, "kind": issue.stage.kind },
        "assignee": issue.assignee.as_ref().map(|p| &p.display_name),
        "priority": issue.priority,
        "labels": issue.labels.iter().map(|l| &l.name).collect::<Vec<_>>(),
        "project": issue.project.as_ref().map(|p| &p.name),
        "milestone": issue.milestone.as_ref().map(|m| &m.name),
        "sprint": issue.sprint.as_ref().map(|s| &s.name),
        "parent": issue.parent.as_ref().map(|p| &p.key),
        "estimate": issue.estimate,
        "deadline": issue.deadline,
        "subtasks": { "total": issue.subtask_total, "completed": issue.subtask_completed },
        "archived": issue.archived_at.is_some(),
        "created_at": issue.created_at,
        "updated_at": issue.updated_at,
    })
}

async fn overview(store: &Store, scope: Scope) -> Result<Value> {
    let dir = Directory::load(store, scope).await?;
    let me = dir.person(dir.me);
    let roles: std::collections::BTreeMap<Uuid, crate::domain::Role> =
        resources::member_list(store, scope)
            .await?
            .into_iter()
            .map(|m| (m.id, m.role))
            .collect();
    let team_keys = |ids: &[Uuid]| ids.iter().map(|id| dir.team(*id).key).collect::<Vec<_>>();
    let project_teams: std::collections::BTreeMap<Uuid, Vec<Uuid>> =
        sqlx::query_as::<_, (Uuid, Vec<Uuid>)>(
            "SELECT project_id,array_agg(team_id ORDER BY team_id) FROM project_teams \
         WHERE workspace_id=$1 GROUP BY project_id",
        )
        .bind(scope.workspace)
        .fetch_all(&store.pool)
        .await?
        .into_iter()
        .collect();

    Ok(json!({
        "me": { "id": me.id, "display_name": me.display_name, "email": me.email },
        "teams": dir.teams.iter().map(|t| json!({
            "id": t.id,
            "key": t.key,
            "name": t.name,
            "stages": dir.stages.iter().filter(|s| s.team_id == t.id).map(|s| &s.stage).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "labels": dir.labels.iter().map(|l| json!({ "id": l.id, "name": l.name })).collect::<Vec<_>>(),
        "projects": dir.projects.iter().map(|p| json!({
            "id": p.id,
            "name": p.name,
            "teams": team_keys(project_teams.get(&p.id).map_or(&[][..], Vec::as_slice)),
            "milestones": dir.milestones.iter().filter(|m| m.project_id == p.id).map(|m| json!({
                "id": m.milestone.id, "name": m.milestone.name, "deadline": m.deadline,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "open_sprints": dir.sprints.iter()
            .filter(|s| matches!(s.sprint.state, SprintState::Planned | SprintState::Active))
            .map(|s| json!({
                "id": s.sprint.id,
                "team": dir.team(s.team_id).key,
                "number": s.sprint.number,
                "name": s.sprint.name,
                "state": s.sprint.state,
                "starts_at": s.starts_at,
                "ends_at": s.ends_at,
            })).collect::<Vec<_>>(),
        "members": dir.members.iter().map(|id| {
            let p = dir.person(*id);
            json!({ "id": p.id, "display_name": p.display_name, "email": p.email, "role": roles.get(id) })
        }).collect::<Vec<_>>(),
    }))
}

async fn projects(store: &Store, scope: Scope, page: &PageParams) -> Result<Value> {
    let dir = Directory::load(store, scope).await?;
    let projects =
        resources::list_collection::<Project>(store, scope, "projects", page, None).await?;
    Ok(json!({
        "projects": projects.data.iter().map(|p| json!({
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "teams": p.team_ids.iter().map(|id| dir.team(*id).key).collect::<Vec<_>>(),
            "milestones": dir.milestones.iter().filter(|m| m.project_id == p.id).map(|m| json!({
                "id": m.milestone.id, "name": m.milestone.name, "deadline": m.deadline,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "next_cursor": projects.next_cursor,
    }))
}

async fn sprints(store: &Store, scope: Scope, mut args: Map<String, Value>) -> Result<Value> {
    let dir = Directory::load(store, scope).await?;
    let team = match args.remove("team").filter(|v| !v.is_null()) {
        Some(Value::String(team)) => Some(dir.find_team(&team)?),
        Some(_) => return Err(Error::BadRequest("team must be a string".into())),
        None => None,
    };
    let states: Vec<SprintState> = match args.remove("state").filter(|v| !v.is_null()) {
        Some(states) => serde_json::from_value(states)
            .map_err(|error| Error::BadRequest(format!("invalid state: {error}")))?,
        None => vec![SprintState::Planned, SprintState::Active],
    };
    Ok(json!({
        "sprints": dir.sprints.iter()
            .filter(|s| team.is_none_or(|t| s.team_id == t) && states.contains(&s.sprint.state))
            .map(|s| json!({
                "id": s.sprint.id,
                "team": dir.team(s.team_id).key,
                "number": s.sprint.number,
                "name": s.sprint.name,
                "state": s.sprint.state,
                "goal": s.goal,
                "starts_at": s.starts_at,
                "ends_at": s.ends_at,
            })).collect::<Vec<_>>(),
    }))
}
