# {{projectName}} agent guide

## Before editing

- Read the nearest context files and inspect the relevant implementation.
- Confirm dependency versions from `package.json` and the lockfile.
- Write a failing test before changing production behavior.

## Delivery

- Use small, reviewable changes.
- Never commit secrets, generated dependencies, or unrelated build output.
- Report the exact verification commands and their results.
