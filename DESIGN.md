# Design

The frontend is an operational reference client. A compact sidebar provides workspaces and views; the main column provides lists, forms, and issue detail. Native HTML controls and visible labels keep behavior easy to inspect and replace.

Use a neutral paper background, dark ink, thin separators, and restrained blue links/actions. Dark mode reverses the surfaces and adjusts the foreground for contrast. System mode follows the operating system. Use the system UI font without a separate display face because this is a deliberately simple application interface.

Keep issues in rows with number, title, stage, assignee, priority, and deadline. Boards group those same issues into team stages. Place issue editing, discussion, attachments, and time entries together. Empty states explain the next useful action. Render server text through escaped HTML or textContent; Markdown rendering belongs to the backend.

English and Polish strings share one dictionary. Forms retain visible focus, disabled states, status messages, and responsive layouts. Avoid illustrative content, decorative imagery, elaborate animation, or invented product claims.
