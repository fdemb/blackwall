# Design

Linear is the reference: dense, keyboard-first, quiet. A neutral sidebar holds the workspace switcher, inbox, teams, and saved views. The main column holds one page at a time. Issue detail is a full page with properties on the right, not a modal.

Color is neutral (slightly cool grays) with one accent, violet, used for primary actions, selection, focus rings, progress, and the done state. Status colors (amber for in progress, red for urgent and overdue) appear only as small icons and chips. Light, dark, and system themes share the same tokens in `web/app/app.css`.

Type is Inter Variable at 13px for the interface and 14px for long text. Numbers use tabular figures. JetBrains Mono appears only for code and identifiers.

Components are shadcn-style wrappers over React Aria Components in `web/app/components/ui`, so keyboard, focus, and screen reader behavior come from the library. Drag and drop uses React Aria's collection hooks, which also work from the keyboard.

Everything is reachable from Ctrl/Cmd+K. `C` creates an issue, `/` searches, `G` then `I`, `M`, `A`, `P`, or `R` jumps between pages. The single-key shortcuts can be turned off in Account, and Ctrl/Cmd+K keeps working. Empty states name the next action. Motion is short and disabled under `prefers-reduced-motion`.

English and Polish share one typed dictionary in `web/app/locales`. Markdown is rendered and sanitized by the backend.
