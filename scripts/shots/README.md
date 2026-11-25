# Website screenshots

Headless Chrome over CDP against the dev mock (`pnpm dev`, port 1420) with `?shots`, which gives
terminals a real-looking session (a deploy on a server; Claude Code in `~/Projects`). Each capture
seeds `localStorage` from a JSON file (a workspace layout, thumbnails on), runs a script with the
helpers in `lib.js` (`pick`, `ctx`, `hover`, `menuItem`, `press`, `side`, `settingsPage` …) and
saves a PNG at 2x. A script that returns a CSS selector crops to that element (the dialogs do).

```sh
pnpm dev                                  # in another terminal
OUT=/tmp/kybl-shots scripts/shots/run.sh  # every shot in shots.txt, light and dark
OUT=/tmp/kybl-shots scripts/shots/run.sh mirror palette   # just these
OUT=/tmp/kybl-shots scripts/shots/phone.sh                # the phone app's three screens
magick /tmp/kybl-shots/app-sync.png -crop 1572x966+660+132 +repage /tmp/kybl-shots/app-sync.png
```

The phone screens are put side by side, with rounded corners, into `phone.png` (see the commit
that added this note), then everything becomes WebP for the site:

```sh
OUT=/tmp/kybl-shots scripts/shots/webp.sh  # -> website/assets/shots/<name>.webp and <name>-dark.webp
```

`shots.txt` lists each shot: its name, seed, script and window size. The feature gallery
(`website/features/`), the manual (`website/manual/`) and the README use these names. A single
capture: `node scripts/shots/cap.mjs out.png light scripts/shots/hero.json scripts/shots/hero.js`.
`URL=` and `DPR=` override the page and the pixel ratio (the share image: a 1200x630 page at DPR=1).

Panes other than the first don't reopen a remote connection from the seed, so scripts open one
through the pane's own picker (`openServerRight`). SSH connections open terminals only; file panes
on a server use the SFTP "Web server".
