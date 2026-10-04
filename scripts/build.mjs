// Builds the published site into dist/.
//
// The photographs are not in this repository. Each build fetches the
// originals named in src/photos.json from S3, resizes them, and writes the
// derivatives beside the document, so they are served from the same origin
// and over the same connection as the page itself.
//
// The stylesheet, the script, and the icon are inlined into the document, and
// the build fails if that document outgrows what a server sends before it
// waits for the first acknowledgement.

import { brotliCompressSync, constants as zlib } from "node:zlib";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { transform } from "esbuild";
import { minify } from "html-minifier-terser";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const cache = path.join(root, ".cache");

// Widths a mosaic preview is offered at. A paired photograph on a phone is
// about 200 CSS px wide and a lone landscape on a large retina display can
// pass 900, so the set runs from one to the other.
const PREVIEW_WIDTHS = [320, 480, 640, 960, 1280, 1920];
// Browsers without AVIF get WebP, at fewer widths to keep the document small.
const FALLBACK_WIDTHS = [640, 1280];
// The opened view: the long edge of a WebP large enough to pinch into.
const FULL_EDGE = 2560;

const AVIF = { quality: 50, effort: 4 };
const WEBP = { quality: 76, effort: 4 };
const FULL_WEBP = { quality: 76, effort: 4 };

// Ten TCP segments is the usual initial congestion window, roughly 14.6 kB.
// Under that, less the response headers, the whole document arrives in the
// first round trip after the handshake.
const DOCUMENT_BUDGET = 13_000;

// Where wide screens start, and the row height they aim for. Both mirror
// site.css: 48rem and --row-height.
const WIDE = "48rem";
const ROW_HEIGHT = 304;
// A wide-screen row stretches past --row-height to justify, usually by 1.0 to
// 1.5 times. The sizes attribute assumes the middle: allowing for the most
// would double the bytes of the first photograph on a laptop.
const ROW_STRETCH = 1.25;

const escape = (text) =>
    text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

async function original(origin, key) {
    const file = path.join(cache, "originals", key.replaceAll("/", "-"));
    if (existsSync(file)) return file;

    const url = new URL(key, origin);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // A stalled connection fails the attempt rather than the build.
            const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`${response.status} for ${url}`);
            await mkdir(path.dirname(file), { recursive: true });
            // Written beside the cache and renamed, so an interrupted
            // download never leaves a truncated original behind.
            await writeFile(`${file}.part`, Buffer.from(await response.arrayBuffer()));
            await rename(`${file}.part`, file);
            return file;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
    }
    throw new Error(`Could not fetch ${url}`, { cause: lastError });
}

// Writes one derivative unless an earlier build already cached it. The cache
// name carries the original's key and every setting, so changing any of them
// re-encodes.
async function derive(photo, source, name, resize, format, options) {
    const tag = createHash("sha1")
        .update(JSON.stringify([photo.key, resize, format, options]))
        .digest("hex")
        .slice(0, 12);
    const cached = path.join(cache, "derived", `${tag}-${name}`);
    if (!existsSync(cached)) {
        await mkdir(path.dirname(cached), { recursive: true });
        // rotate() applies the EXIF orientation before it is stripped along
        // with the rest of the metadata.
        await sharp(source)
            .rotate()
            .resize({ ...resize, withoutEnlargement: true })
            [format](options)
            .toFile(`${cached}.part`);
        await rename(`${cached}.part`, cached);
    }
    await cp(cached, path.join(dist, "i", name));
    return `/i/${name}`;
}

async function buildPhoto(photo, origin) {
    const source = await original(origin, photo.key);
    const { dominant } = await sharp(await sharp(source).rotate().resize(64).toBuffer()).stats();
    const meta = await sharp(source).metadata();
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;

    // An original narrower than the smallest width is offered as it is.
    const upTo = (candidates) => {
        const fitting = candidates.filter((w) => w <= width);
        return fitting.length ? fitting : [width];
    };
    const widths = upTo(PREVIEW_WIDTHS);
    const fallbackWidths = upTo(FALLBACK_WIDTHS);

    const [avif, webp, full] = await Promise.all([
        Promise.all(
            widths.map(async (w) => ({
                w,
                url: await derive(photo, source, `${photo.id}-${w}.avif`, { width: w }, "avif", AVIF),
            })),
        ),
        Promise.all(
            fallbackWidths.map(async (w) => ({
                w,
                url: await derive(photo, source, `${photo.id}-${w}.webp`, { width: w }, "webp", WEBP),
            })),
        ),
        derive(
            photo,
            source,
            `${photo.id}.webp`,
            { width: FULL_EDGE, height: FULL_EDGE, fit: "inside" },
            "webp",
            FULL_WEBP,
        ),
    ]);

    return {
        ...photo,
        width,
        height,
        ratio: width / height,
        colour: `#${[dominant.r, dominant.g, dominant.b]
            .map((c) => c.toString(16).padStart(2, "0"))
            .join("")}`,
        avif,
        webp,
        full,
    };
}

const EAGER_ROWS = 3;

const srcset = (candidates) => candidates.map(({ w, url }) => `${url} ${w}w`).join(", ");

// The first three rows are on screen, or nearly, when the page loads on a
// phone or a laptop, so they load eagerly, and the very first photograph, the
// likely LCP element, goes ahead of everything else. The rest wait until the
// visitor scrolls near them.
function renderPhoto(photo, { share, rowIndex }) {
    const sizes = `(min-width: ${WIDE}) ${Math.ceil(photo.ratio * ROW_HEIGHT * ROW_STRETCH)}px, ${Math.ceil(share * 100)}vw`;
    const fallback = photo.webp.at(-1);
    const priority =
        rowIndex === 0
            ? ' fetchpriority="high"'
            : rowIndex < EAGER_ROWS
              ? ' decoding="async"'
              : ' loading="lazy" decoding="async"';
    const caption = photo.caption ? ` data-caption="${escape(photo.caption)}"` : "";

    return `
        <a class="photo" data-frame href="${photo.full}"${caption}
            style="--r: ${photo.ratio.toFixed(3)}; --c: ${photo.colour}">
            <picture>
                <source type="image/avif" srcset="${srcset(photo.avif)}" sizes="${sizes}" />
                <img src="${fallback.url}" srcset="${srcset(photo.webp)}" sizes="${sizes}"
                    width="${photo.width}" height="${photo.height}"
                    alt="${escape(photo.alt)}"${priority} />
            </picture>
        </a>`;
}

function renderRows(rows) {
    return rows
        .map((row, rowIndex) => {
            const total = row.reduce((sum, photo) => sum + photo.ratio, 0);
            const photos = row.map((photo) =>
                renderPhoto(photo, { share: photo.ratio / total, rowIndex }),
            );
            return `<div class="row">${photos.join("")}</div>`;
        })
        .join("\n");
}

// The old site had these two pages. They now live on the home page.
const redirect = (target) =>
    `<!doctype html><meta charset="utf-8"><title>David Drabik</title>` +
    `<link rel="canonical" href="https://daviddrabik.com${target}">` +
    `<meta http-equiv="refresh" content="0;url=${target}">` +
    `<a href="${target}">David Drabik</a>`;

async function build() {
    const { origin, rows } = JSON.parse(await readFile(path.join(src, "photos.json"), "utf8"));

    const ids = new Set();
    for (const photo of rows.flat()) {
        for (const field of ["id", "key", "alt"]) {
            if (!photo[field]) throw new Error(`A photograph in photos.json has no ${field}.`);
        }
        if (ids.has(photo.id)) throw new Error(`photos.json uses the id "${photo.id}" twice.`);
        ids.add(photo.id);
    }

    await rm(dist, { recursive: true, force: true });
    await mkdir(path.join(dist, "i"), { recursive: true });
    await mkdir(path.join(dist, "pages"), { recursive: true });

    // One photograph at a time: the encoders already use every core.
    const built = [];
    for (const row of rows) {
        const photos = [];
        for (const photo of row) photos.push(await buildPhoto(photo, origin));
        built.push(photos);
    }

    const [template, css, js, icon] = await Promise.all(
        ["index.html", "site.css", "site.js", "icon.svg"].map((name) =>
            readFile(path.join(src, name), "utf8"),
        ),
    );
    const minified = {
        css: (await transform(css, { loader: "css", minify: true })).code.trim(),
        js: (await transform(js, { loader: "js", minify: true, format: "esm", target: "es2020" }))
            .code.trim(),
        icon: `data:image/svg+xml,${encodeURIComponent(
            await minify(icon, { collapseWhitespace: true, removeComments: true, keepClosingSlash: true }),
        )}`,
        photos: renderRows(built),
    };

    const page = await minify(
        template.replace(/\{\{(\w+)\}\}/g, (_, name) => minified[name]),
        {
            collapseWhitespace: true,
            removeComments: true,
            // The CDN reads these two to leave the email link alone.
            ignoreCustomComments: [/^\/?email_off$/],
            removeAttributeQuotes: true,
            collapseBooleanAttributes: true,
            sortAttributes: true,
        },
    );

    await writeFile(path.join(dist, "index.html"), page);
    await writeFile(path.join(dist, "pages", "about.html"), redirect("/#about"));
    await writeFile(path.join(dist, "pages", "contact.html"), redirect("/#about"));
    await cp(path.join(root, "static"), dist, { recursive: true });

    const wire = brotliCompressSync(page, {
        params: { [zlib.BROTLI_PARAM_QUALITY]: 4 },
    }).length;
    console.log(
        `index.html: ${Buffer.byteLength(page)} bytes, ${wire} compressed (budget ${DOCUMENT_BUDGET})`,
    );
    if (wire > DOCUMENT_BUDGET) {
        throw new Error(
            `index.html compresses to ${wire} bytes, over the ${DOCUMENT_BUDGET} byte budget ` +
                "that keeps it inside the first round trip.",
        );
    }
}

await build();
