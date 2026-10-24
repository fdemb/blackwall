# Design

Linear is the reference: dense, keyboard-first, quiet. A neutral sidebar holds the workspace switcher, inbox, teams, and saved views. The main column holds one page at a time. Issue detail is a full page with properties on the right, not a modal.

Color is neutral (warm stone grays) with one accent, coral, used for primary actions, selection, focus rings, progress, and the done state. Status colors (amber for in progress, red for urgent and overdue) appear only as small icons and chips. Light, dark, and system themes share the same tokens in `web/app/app.css`.

Type is Inter Variable at 13px for the interface and 14px for long text. Numbers use tabular figures. JetBrains Mono appears only for code and identifiers.

Components are shadcn-style wrappers over React Aria Components in `web/app/components/ui`, so keyboard, focus, and screen reader behavior come from the library. Drag and drop uses React Aria's collection hooks, which also work from the keyboard.

Everything is reachable from Ctrl/Cmd+K. `C` creates an issue, `/` searches, `G` then `I`, `M`, `A`, `P`, or `R` jumps between pages. The single-key shortcuts can be turned off in Account, and Ctrl/Cmd+K keeps working. Empty states name the next action. Motion is short and disabled under `prefers-reduced-motion`.

English and Polish use i18next and react-i18next with typed catalogs in `web/app/locales`. `useI18n()` exposes the native typed `t` function and app language preferences. Use `{{name}}` for interpolation and `t("count.issues", { count })` for plural messages. English defines `_one` and `_other`; Polish defines `_one`, `_few`, `_many`, and `_other`. Each React root owns an i18next instance, and its resolved language drives React Aria and `<html lang>`. The saved `bw-lang:v1` preference takes precedence over the browser language until the signed-in profile loads. Dates and numbers use native `Intl` formatting.

Markdown is rendered and sanitized by the backend. Descriptions and comments are written in a WYSIWYG Tiptap editor (`web/app/components/app/editor`) that loads and saves markdown, so stored text and the API stay plain. `/` inserts blocks, `@` mentions a member, and selecting text shows a formatting toolbar. Issue descriptions are always editable and save a second after typing pauses, or as soon as focus leaves them. Rendered markdown and the editor share the `typeset` class from `web/app/typeset.css`, a tuned copy of shadcn/typeset.

The new issue dialog puts the title and description first. Team, status, priority, assignee, and labels sit below as pills. Project, sprint, deadline, and estimate wait behind a "…" pill and join the row once set.
