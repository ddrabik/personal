# David Drabik Photography Portfolio

The source of [daviddrabik.com](https://daviddrabik.com): one page of landscape
and wildlife photographs laid out as a justified mosaic, with a short profile
underneath.

## How it is built

```sh
npm install
npm run build     # writes dist/
npm run preview   # serves dist/ on http://localhost:4173
```

| Path | Holds |
| --- | --- |
| `src/index.html` | The page. `{{css}}`, `{{js}}`, `{{icon}}`, and `{{photos}}` are filled in by the build. |
| `src/site.css`, `src/site.js` | The stylesheet and the script, inlined into the page. |
| `src/photos.json` | The photographs, in rows as a phone shows them. |
| `static/` | Files copied into `dist/` unchanged. |
| `scripts/build.mjs` | The build. |

### Photographs

The photographs are not in this repository. The originals live in S3, and each
build fetches the ones named in `src/photos.json`, resizes them, and writes the
results to `dist/i/`:

- mosaic previews as AVIF at up to six widths, with WebP for older browsers
- one WebP for the opened view, 2560 px on its long edge

To add a photograph, upload the original to S3 and add an entry to
`src/photos.json`: an `id` for the file names, the S3 `key`, the `alt` text, and
an optional `caption` for the opened view. Its dimensions, aspect ratio, and
placeholder colour are read from the file.

### First load

The page is built to arrive in the first round trip after the handshake:

- The stylesheet, script, and icon are inlined, so the document is the only
  request before the photographs. System fonts; nothing else is fetched.
- The build fails if the compressed document passes 13 kB, which is what fits
  in a server's initial ten-packet window.
- Photographs are served from the same origin, so they reuse the document's
  connection instead of opening one to S3.
- The first photograph is fetched at high priority, the rest of the first
  screen eagerly, and everything below only as the visitor scrolls near it.
- Every photograph reserves its space and shows its dominant colour until it
  lands, so nothing shifts.

## Deployment

DigitalOcean App Platform builds and publishes `main` on every push. The app's
static site component must run `npm run build` and publish `dist`;
[`.do/app.yaml`](.do/app.yaml) records that spec.

## License

All photographs are the exclusive property of David Drabik. Please do not use, reproduce, or distribute without explicit permission.
