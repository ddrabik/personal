// A justified mosaic, with a header that leaves on the way down and an opened
// view that swipes from one photograph to the next. The build inlines this
// file into the document, so it costs no request of its own.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Header: leaves on the way down, returns on the way up ------ */

let lastScrollY = window.scrollY;

window.addEventListener(
    "scroll",
    () => {
        const y = window.scrollY;
        if (y < 80) {
            delete document.body.dataset.header;
        } else if (Math.abs(y - lastScrollY) > 6) {
            document.body.dataset.header = y > lastScrollY ? "hidden" : "shown";
        }
        lastScrollY = y;
    },
    { passive: true },
);

/* ---------- Thin progress line ---------------------------------------- */

const progressBar = document.querySelector("[data-progress]");

if (progressBar) {
    const update = () => {
        const scrollable =
            document.documentElement.scrollHeight - window.innerHeight;
        const ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
        // A transform, so a scroll never costs a layout.
        progressBar.style.transform = `scaleX(${Math.min(1, Math.max(0, ratio))})`;
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
}

/* ---------- The opened view -------------------------------------------- */
// The full-screen WebP is requested only after a visitor opens a photograph.

const lightbox = document.querySelector("[data-lightbox]");

if (lightbox) {
    const zoomer = lightbox.querySelector("[data-zoomer]");
    const image = lightbox.querySelector("[data-lightbox-image]");
    const loading = lightbox.querySelector("[data-lightbox-loading]");
    const hint = lightbox.querySelector("[data-zoom-hint]");
    const caption = lightbox.querySelector("[data-lightbox-caption]");

    /* ------- Pinch to zoom, drag to pan, double tap to toggle ---------- */
    // Pointer Events rather than Touch Events, so one handler covers finger,
    // pen, and mouse. The CSS sets touch-action: none on the zoomer, which is
    // what stops the browser scrolling or page-zooming under the gesture.

    const MAX_SCALE = 6;
    const DOUBLE_TAP_SCALE = 2.5;
    // How far a swipe has to travel before it turns the page, and how long the
    // outgoing photograph takes to leave.
    const SWIPE_DISTANCE = 56;
    const SLIDE_MS = 160;

    const frames = [...document.querySelectorAll("[data-frame]")];
    let current = -1;
    let switching = false;
    let hinted = false;

    const pointers = new Map();
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let base = null; // The untransformed image rect, in client coordinates.
    let pinchStart = null;
    let panFrom = null;
    let lastTap = 0;
    let lastTapPoint = null;
    let swipeFrom = null;
    let swipeDx = 0;

    const applyTransform = () => {
        image.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        zoomer.dataset.zoomed = scale > 1 ? "true" : "false";
    };

    // Measure where the image sits with no transform applied, so every later
    // calculation can work from a stable origin.
    const measureBase = () => {
        const previous = image.style.transform;
        const transition = image.style.transition;
        // A running transition would report a rect partway through the slide.
        image.style.transition = "none";
        image.style.transform = "none";
        const rect = image.getBoundingClientRect();
        base = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
        image.style.transform = previous;
        void image.offsetWidth;
        image.style.transition = transition;
    };

    // Keep the photograph covering the frame when it is larger than the frame,
    // and centred when it is smaller. Without this a pinch can fling the
    // picture off-screen and leave a black rectangle.
    const clamp = () => {
        if (!base) return;
        const view = zoomer.getBoundingClientRect();
        const width = base.width * scale;
        const height = base.height * scale;

        if (width <= view.width) {
            tx = view.left - base.left + (view.width - width) / 2;
        } else {
            const min = view.right - base.left - width;
            const max = view.left - base.left;
            tx = Math.min(max, Math.max(min, tx));
        }

        if (height <= view.height) {
            ty = view.top - base.top + (view.height - height) / 2;
        } else {
            const min = view.bottom - base.top - height;
            const max = view.top - base.top;
            ty = Math.min(max, Math.max(min, ty));
        }
    };

    // Rescale around a fixed client point, so the pixel under the fingers stays
    // under the fingers.
    const zoomAround = (nextScale, clientX, clientY) => {
        if (!base) measureBase();
        const target = Math.min(MAX_SCALE, Math.max(1, nextScale));
        const localX = (clientX - base.left - tx) / scale;
        const localY = (clientY - base.top - ty) / scale;
        scale = target;
        tx = clientX - base.left - localX * scale;
        ty = clientY - base.top - localY * scale;
        clamp();
        applyTransform();
    };

    const resetZoom = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        pointers.clear();
        pinchStart = null;
        panFrom = null;
        swipeFrom = null;
        swipeDx = 0;
        image.style.transform = "";
        zoomer.dataset.zoomed = "false";
    };

    const centroid = () => {
        const points = [...pointers.values()];
        const sum = points.reduce(
            (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
            { x: 0, y: 0 },
        );
        return { x: sum.x / points.length, y: sum.y / points.length };
    };

    const spread = () => {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    };

    zoomer.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        zoomer.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.size === 2) {
            // A second finger turns a swipe into a pinch.
            if (swipeFrom) {
                swipeFrom = null;
                swipeDx = 0;
                applyTransform();
            }
            if (!base) measureBase();
            pinchStart = { distance: spread(), scale, point: centroid() };
            panFrom = null;
            return;
        }

        if (pointers.size === 1) {
            // Double tap toggles between fit and a close look at the tap point.
            const now = performance.now();
            const near =
                lastTapPoint &&
                Math.hypot(
                    event.clientX - lastTapPoint.x,
                    event.clientY - lastTapPoint.y,
                ) < 30;

            if (now - lastTap < 300 && near) {
                zoomAround(
                    scale > 1 ? 1 : DOUBLE_TAP_SCALE,
                    event.clientX,
                    event.clientY,
                );
                if (scale === 1) {
                    clamp();
                    applyTransform();
                }
                lastTap = 0;
                lastTapPoint = null;
                return;
            }

            lastTap = now;
            lastTapPoint = { x: event.clientX, y: event.clientY };
            panFrom = scale > 1 ? { x: event.clientX, y: event.clientY, tx, ty } : null;
            // At fit, a sideways drag belongs to the swipe between photographs.
            swipeFrom = scale === 1 && !switching ? { x: event.clientX } : null;
            swipeDx = 0;
        }
    });

    zoomer.addEventListener("pointermove", (event) => {
        if (!pointers.has(event.pointerId)) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.size >= 2 && pinchStart) {
            event.preventDefault();
            const distance = spread();
            if (!distance || !pinchStart.distance) return;
            const point = centroid();
            // Follow the midpoint as well as the spread, so a two-finger drag
            // pans while it zooms.
            tx += point.x - pinchStart.point.x;
            ty += point.y - pinchStart.point.y;
            pinchStart.point = point;
            zoomAround(
                (pinchStart.scale * distance) / pinchStart.distance,
                point.x,
                point.y,
            );
            return;
        }

        if (pointers.size === 1 && swipeFrom && scale === 1) {
            event.preventDefault();
            const dx = event.clientX - swipeFrom.x;
            // At either end of the selection the photograph resists rather
            // than following the finger.
            swipeDx = neighbour(dx < 0 ? 1 : -1) ? dx : dx * 0.3;
            image.style.transform = `translate(${tx + swipeDx}px, ${ty}px)`;
            return;
        }

        if (pointers.size === 1 && panFrom && scale > 1) {
            event.preventDefault();
            tx = panFrom.tx + (event.clientX - panFrom.x);
            ty = panFrom.ty + (event.clientY - panFrom.y);
            clamp();
            applyTransform();
        }
    });

    const releasePointer = (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchStart = null;
        if (pointers.size === 0) {
            panFrom = null;
            if (swipeFrom) {
                const dx = swipeDx;
                swipeFrom = null;
                swipeDx = 0;
                if (Math.abs(dx) > SWIPE_DISTANCE && neighbour(dx < 0 ? 1 : -1)) {
                    step(dx < 0 ? 1 : -1);
                    return;
                }
                if (dx) ease();
            }
            // A pinch that ends below 1× settles back to fit.
            if (scale <= 1) {
                scale = 1;
                clamp();
                applyTransform();
            }
        }
    };

    zoomer.addEventListener("pointerup", releasePointer);
    zoomer.addEventListener("pointercancel", releasePointer);

    image.addEventListener("load", () => {
        measureBase();
        clamp();
        applyTransform();
    });

    window.addEventListener(
        "resize",
        () => {
            if (!lightbox.open) return;
            measureBase();
            clamp();
            applyTransform();
        },
        { passive: true },
    );

    /* ------- Swiping between photographs ------------------------------- */
    // Only at fit. Once a photograph is zoomed, a one-finger drag pans it, so
    // the two gestures never compete. Arrow keys do the same on a keyboard.

    const neighbour = (direction) => frames[current + direction];

    const ease = () => {
        if (reduceMotion) return;
        image.style.transition = `transform ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out`;
        window.setTimeout(() => {
            image.style.transition = "";
        }, SLIDE_MS);
    };

    const step = (direction) => {
        const next = neighbour(direction);
        if (!next || switching) return;
        if (reduceMotion) {
            open(next);
            return;
        }

        // The outgoing photograph leaves the way it was pushed; the incoming
        // one fades up in place.
        switching = true;
        const width = zoomer.getBoundingClientRect().width;
        ease();
        image.style.transform = `translate(${tx - direction * width}px, ${ty}px)`;
        image.style.opacity = "0";

        window.setTimeout(() => {
            switching = false;
            // Closed mid-slide: opening the next one would reopen the dialog.
            if (!lightbox.open) return;
            image.style.transition = "none";
            open(next);
            void image.offsetWidth;
            ease();
            image.style.opacity = "";
        }, SLIDE_MS);
    };

    lightbox.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        if (scale !== 1) return;
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
    });

    /* ------- Opening a photograph ------------------------------------------- */

    const open = (frame) => {
        const preview = frame.querySelector("img");
        current = frames.indexOf(frame);
        resetZoom();
        base = null;

        // A place or a species, or nothing at all.
        caption.textContent = frame.dataset.caption ?? "";
        caption.hidden = !frame.dataset.caption;

        // Show the preview immediately, then swap in the full view once it
        // lands. A neighbour reached by swiping may not have scrolled into view
        // yet, in which case its lazy preview has no currentSrc.
        image.src = preview?.currentSrc || preview?.src || "";
        // The ratio sizes the photograph's box before either file has loaded.
        image.style.setProperty("--r", frame.style.getPropertyValue("--r"));
        image.alt = preview?.alt ?? "";
        loading.hidden = false;

        if (!lightbox.open) lightbox.showModal();

        if (hint && !hinted && window.matchMedia("(pointer: coarse)").matches) {
            hinted = true;
            hint.dataset.visible = "true";
            window.setTimeout(() => delete hint.dataset.visible, 2400);
        }

        const full = new Image();
        full.decoding = "async";
        full.addEventListener("load", () => {
            // A swipe may have moved on before this one arrived.
            if (frames[current] !== frame) return;
            if (lightbox.open) image.src = full.src;
            loading.hidden = true;
        });
        full.addEventListener("error", () => {
            if (frames[current] === frame) loading.hidden = true;
        });
        full.src = frame.href;
    };

    // Each photograph is a link to its full view, so it is focusable, opens on
    // Enter, and still leads somewhere without this script. A modified click
    // keeps the browser's own behaviour, such as opening a new tab.
    for (const frame of frames) {
        frame.addEventListener("click", (event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            open(frame);
        });
    }

    // A click on the backdrop lands on the dialog itself.
    lightbox.addEventListener("click", (event) => {
        if (event.target === lightbox) lightbox.close();
    });

    lightbox.addEventListener("close", () => {
        resetZoom();
        current = -1;
        image.style.opacity = "";
        image.removeAttribute("src");
        loading.hidden = true;
        if (hint) delete hint.dataset.visible;
    });
}
