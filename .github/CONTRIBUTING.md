# Contributing to Kybl

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas**: open an [issue](https://github.com/erikkubica/kybl/issues/new/choose) first,
  so we can agree on the approach before you spend time on code.
- **Security problems**: please don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Small fixes** (a typo, a wrong label, an obvious bug) can go straight to a pull request.

## Setting up

You need Rust (stable), Node (LTS) and pnpm. On Linux you also need the WebKitGTK build
dependencies listed in `.github/workflows/ci.yml`.

```bash
pnpm install
pnpm tauri dev    # the desktop app
pnpm dev          # the UI only, in a browser, with demo data (src/dev/devMock.ts)
```

`pnpm dev` is the quickest way to work on the interface. Add `?mobile` to the URL for the phone
layout, and `?os=win` or `?os=linux` to see another system's layout. The phone apps are covered in
the README.

## Checks

Run these before sending a pull request. CI runs the same ones.

```bash
npx tsc --noEmit -p .                    # typecheck
pnpm test                                # frontend unit tests (tests/)
cd src-tauri && cargo test --lib         # Rust tests
```

The S3 end-to-end tests in the Rust suite run when `KYBL_TEST_ENDPOINT` points at a test S3
server (CI starts one with rclone); without it they are skipped.

## How the code is organised

- `src/`: the React frontend. It is grouped by feature: `browser` (panes), `shell` (the window
  around them), `transfers`, `sync`, `mirror`, `terminal`, `settings`, `mobile` and more.
- `src-tauri/src/`: the Rust backend. `storage/` has one backend per connection type (see
  `storage/BACKENDS.md`), alongside transfers, sync, terminals, archives and mounting.
- `docs/FEATURES.md`: the inventory of every feature, menu, shortcut and setting.
- `website/`: kybl.app, including the [manual](https://kybl.app/manual/).

## Style

- **Plain words in the interface**: say what happens, in the user's terms ("Move to Trash", not
  "Delete object").
- **Comments explain why**, not what the next line does.
- **Keep Kybl lean**: lazy-load big features, reuse the dependencies that are already there, and
  avoid adding a library for something small.
- **Behaviour changes**: update the manual and `docs/FEATURES.md` in the same pull request.
- **Visible changes**: attach screenshots in light and dark.

## Pull requests

- One topic per pull request, with a clear description of what changes for the user.
- Add tests for logic that can be tested without the UI (`tests/` or Rust unit tests).
- By contributing, you agree that your work is released under the [MIT License](../LICENSE).
