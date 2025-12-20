# Commands

- Dev: `bun run dev`
- Build: `bun run build`
- Test: `bun run test` (Single: `bun run test <path>`)
- DB: `bun run db:generate` (gen migrations), `bun run db:migrate` (apply), `bun run db:seed`

# Architecture & Structure

- **Stack:** TanStack Start, SolidJS, TanStack Router, Drizzle ORM (SQLite), Tailwind CSS (v4).
- **Structure:**
  - `src/features/`: Feature-based modules (auth, issues, workspaces, etc.).
  - `src/routes/`: TanStack file-based routing.
  - `src/db/`: Drizzle schema (`schema/`) and migrations.
  - `src/lib/`: Utilities.

# Guidelines

- **Conventions:** Use `bun` for all scripts. Follow feature-folder structure.
- **Styling:** Tailwind CSS with `clsx`/`tailwind-merge`. Use Kobalte/Zag for primitives.
- **Database:** Define schemas in `src/db/schema`. Use `snake_case` for DB columns.
- **Formatting:** Prettier is enforced. Imports are automatically organized.
- **Type Safety:** Strict TypeScript. Use Zod for validation (drizzle-zod).
