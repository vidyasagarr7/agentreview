# Contributing to AgentReview

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/vidyasagarr7/agentreview
cd agentreview
npm install
npm run build
```

## Running Tests

```bash
npm test          # typecheck + vitest
npm run typecheck # TypeScript only
```

## Project Structure

```
src/
├── cli/            # CLI entry point, commands, config
├── agents/         # Agent dispatcher + prompt builder
├── github/         # GitHub API client + context builder
├── lenses/         # Built-in + custom lens registry
│   └── builtin/    # Security, architecture, quality lenses
├── llm/            # LLM client + response parser
├── report/         # Consolidator, dedup, renderers
│   └── renderers/  # Markdown + JSON output
└── types/          # Shared TypeScript types
```

## Making Changes

1. **Fork** the repo and create a branch from `main`
2. **Write tests** for new functionality
3. **Run the full suite** before submitting: `npm test`
4. **Keep commits focused** — one logical change per commit
5. **Open a PR** with a clear description of what and why

## Adding Custom Lenses

Want to contribute a new built-in lens? Create it in `src/lenses/builtin/` following the existing pattern (see `security.ts` as an example). A good lens should:

- Have a clear, non-overlapping focus area
- Include specific focus areas in `focusAreas[]`
- Use a detailed system prompt that guides the LLM
- Be tested with representative diffs

## Code Style

- TypeScript strict mode
- ESM imports (`.js` extensions in imports)
- No `any` unless absolutely necessary (use `unknown` + type guards)
- Vitest for testing

## Reporting Issues

- Use GitHub Issues
- Include your Node.js version, OS, and the command you ran
- For LLM-related issues, include the model you're using

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
