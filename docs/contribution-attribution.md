# Contribution Attribution Table

| Component | Author | What the AI did and what you did |
|---|---|---|
| Ingestion service | Applicant | I designed the ingestion flow, reorg handling, and idempotent block writing. |
| Data model | Applicant | I designed the SQLite schema, indexes, and prepared statements. |
| Trace algorithm | Applicant | I implemented the BFS trace (tx, address) and shortest hops logic. |
| API layer | AI | AI wrote all HTTP routes, parameter parsing, validation, and error handling. I reviewed the output. |
| Tests | AI | AI wrote all 22 tests (16 trace, 6 ingestion) including the FakeChain mock. I verified they pass. |
| Documentation | AI | AI wrote the README and architecture document (system-design.md). I reviewed and approved. |
