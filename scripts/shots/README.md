# Website screenshots

Headless Chrome over CDP against the dev mock (`pnpm dev`, port 1420) with `?shots`, which gives
terminals a real-looking session. Each capture seeds `localStorage` (a workspace layout), runs an
optional script, and saves a PNG at 2x.

```sh
node scripts/shots/cap.mjs /tmp/hero-light.png light scripts/shots/hero.json scripts/shots/hero.js
node scripts/shots/cap.mjs /tmp/hero-dark.png dark scripts/shots/hero.json scripts/shots/hero.js
node scripts/shots/cap.mjs /tmp/connect-light.png light scripts/shots/hero.json scripts/shots/connect.js 1200 900
node scripts/shots/cap.mjs /tmp/sync-light.png light scripts/shots/hero.json scripts/shots/sync.js 1200 800
magick /tmp/sync-light.png -crop 1572x966+660+132 +repage /tmp/sync-light-c.png
cwebp -q 82 /tmp/hero-light.png -o website/assets/shots/app-browse.webp
```

A script that returns a CSS selector crops to that element (the connection picker does). `URL=`
and `DPR=` override the page and the pixel ratio (the share image: a 1200x630 page at DPR=1).
