# CODEX.md — AgentReview Project

## CRITICAL: Skip Skills for One-Shot Tasks
When dispatched via `codex exec` with a specific implementation task:
- Do NOT read or invoke any skills (Superpowers, gstack, etc.)
- Do NOT run brainstorming workflows
- Go straight to implementation
- The task prompt IS the approved plan — execute it directly

## Project Info
- TypeScript CLI (commander, tsup, vitest)
- ESM with .js import extensions
- Tests use vitest with mock LLM pattern
