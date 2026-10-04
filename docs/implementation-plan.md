# Implementation status

The PostgreSQL migration replaces the initial portable snapshot design. Existing development data is discarded; no SQLite runtime path or conversion tool is supported.

Implemented modules and verification procedures are documented in [backend design](architecture.md), [verification](verification.md), and the [README](../README.md). The original [PostgreSQL migration plan](postgres-migration-plan.md) remains the scope record.

The application keeps one Rust crate and deployment. PostgreSQL stores relational work records and durable jobs. Frontend and API contracts use entity versions and targeted collections.
