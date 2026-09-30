# Muster

Run a crew of Claude Code agents in parallel on one project, led by a Captain agent you talk to. Every Crew agent works in its own git worktree and branch; nothing reaches `main` until the Captain has reviewed and tested it and you have approved the merge.

Runs natively on Windows (no WSL). See [`docs/SPEC.md`](docs/SPEC.md) for the product and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how it is built. The dashboard design lives in [`docs/design/`](docs/design/).

> Work in progress.
