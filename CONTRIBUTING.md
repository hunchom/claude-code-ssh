# Contributing

Contributions welcome. Keep PRs focused, tests passing, and the README honest.

## Quick start

```bash
git clone https://github.com/hunchom/claude-code-ssh
cd claude-code-ssh
npm install
npm test
```

All 551 tests should pass before you start.

## Workflow

1. Fork, branch off `main`
2. Make the change
3. Add or update tests — we don't merge untested changes
4. Run `npm test` and `./scripts/validate.sh`
5. Commit with a short imperative subject (e.g. `fix: handle empty SSH config`)
6. Open a PR describing what changed and why

## What we're looking for

**Yes:**
- Bug fixes with a reproducing test
- New tools that belong in an existing group
- Docs improvements (especially clearer examples)
- Performance wins backed by numbers
- Support for more auth methods / SSH edge cases

**Probably not:**
- Large refactors without a specific problem they solve
- New tool groups that overlap existing ones
- Dependencies without a clear justification
- Breaking changes to `.env` / TOML format (we'll discuss)

## Code style

- Node 20.19+, ES modules
- Prefer small, pure functions over class hierarchies
- Handler files live in `src/tools/` — one file per tool group
- Every new tool needs an entry in `src/tool-registry.js` and a test file in `tests/`
- No emojis in log output, no Unicode where ASCII works

## Security

If you find a vulnerability, don't open a public issue. Email the maintainer or use GitHub's private security reporting. SSH tools touch production infra — we treat security reports seriously.

## Questions

Open a discussion or issue. Short and specific beats long and vague.
