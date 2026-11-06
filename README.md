# ShipZip

Zip in, website out. An installable Android web app that takes a website `.zip`
(index.html + css + js), commits it to a GitHub repository, turns on GitHub Pages,
and wires up a custom domain at IONOS — all from a phone.

No server, no build step, no tracking. Everything runs in the phone's browser;
the GitHub token and IONOS key are stored only on that phone (browser storage for
the app's own address) and are only ever sent to GitHub and IONOS.

## What it does with the zip

- Unwraps a single top-level folder so `index.html` sits at the root.
- Drops junk (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `.git/`).
- If there's no `index.html` but exactly one top-level `.html`, uses that as the home page.
- Adds `.nojekyll` (otherwise GitHub can drop files/folders starting with `_`).
- Writes `CNAME` with the domain on **every** deploy, so the custom domain never unlinks.
- Refuses files over 100 MB (GitHub's limit), warns near Pages' ~1 GB site limit.
- Warns about links that start with `/` when no custom domain is set (they break on
  `username.github.io/repo/` but work on a custom domain).
- Each deploy is one commit (`Deploy #N from file.zip`) that **replaces** the whole
  site, so deleted files really disappear. History stays in the repo for rollback.

## What it does in IONOS (only after you tap Apply)

- Deletes A / AAAA / CNAME / ALIAS records on the bare domain and `www` that would
  fight with GitHub (IONOS adds parking records by default).
- Adds GitHub Pages' 4 A records, 4 AAAA records, and `www` CNAME → `<user>.github.io`.
- Never touches MX (email), TXT, or other subdomains.
- Claims the domain on GitHub **before** any DNS change (GitHub's advice, prevents takeovers).
- Optional: adds GitHub's domain-verification TXT record for you.

## Known unknowns

- **IONOS from a browser.** The IONOS DNS API might refuse calls made directly from a
  web page (CORS). That couldn't be tested from here. If "Check IONOS" says it can't
  reach IONOS, either use **Do it by hand instead** (copy buttons for every record), or
  deploy `extras/ionos-proxy-worker.js` as a free Cloudflare Worker and paste its
  address into *IONOS API address*. The status checklist works either way.
- **Token permissions.** If GitHub says the token is missing a permission, the error
  names it. A classic token with the `repo` scope also works.
- Free GitHub accounts can only publish Pages from **public** repos; ShipZip creates
  them public.

## Files

| File | What |
|---|---|
| `index.html` | The app UI |
| `app.js` | GitHub, IONOS and DNS-check logic |
| `core.js` | Pure logic: zip cleanup, DNS planning (unit-tested) |
| `sw.js` | Offline support + receives zips from the Android share sheet |
| `manifest.webmanifest` | Install + share-target registration |
| `vendor/jszip.min.js` | JSZip 3.10.1, bundled locally (no CDN at runtime) |
| `extras/ionos-proxy-worker.js` | Optional CORS proxy for IONOS |
