## Summary

<!-- What does this change, and why? One or two sentences a reviewer can read first. -->

Closes #<!-- issue number -->

## Changes

<!-- The notable changes, one bullet each. -->

-

## Testing

<!-- How you checked it, with the actual result. Say what was not tested. -->

-

## Screenshots

<!-- For UI changes: before / after. Delete this section otherwise. -->

## Checklist

- [ ] Branch was cut from an up-to-date `main` and covers only the linked issue
- [ ] `npm run build` passes (tsc + vite)
- [ ] `npm test` passes
- [ ] If Rust changed: `cargo fmt --check` and `cargo clippy -- -D warnings` are clean
- [ ] User-visible change: entry under `## [Unreleased]` in `CHANGELOG.md`
- [ ] New visible strings are in `src/lib/i18n.ts` (German and English)
- [ ] Stays local-first: no telemetry, no secrets, no network calls beyond `127.0.0.1` and OpenRouter
