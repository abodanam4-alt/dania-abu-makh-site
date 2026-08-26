/**
 * SPIN CAROUSEL (Originkit "Radial Image Carousel") — a 3D wheel carousel
 * that arranges images along a circular arc, with drag momentum physics and
 * pointer capture, click-to-center, mouse wheel, auto-play, and
 * scale/opacity/brightness falloff with distance from the front of the wheel.
 *
 * Ported verbatim from the Originkit component (ui/spin-carousel.tsx, stack:
 * react/css). Every constant and formula (SCALE_NEAR/SCALE_FALLOFF, the
 * "sweep every angle, fit the envelope" auto-fit, the click-slop drag
 * detection, the wheel-then-snap debounce) is unchanged. The only change
 * from the original file is the outer shell: the React component
 * (props/useRef/useState/useEffect/JSX) is replaced with a plain factory
 * function, because this site is static HTML/CSS/JS with no React or
 * Framer Motion runtime. In place of `motion/react`'s `animate()`, this file
 * ships a small cubic-bezier tween runner that reproduces the same "tween"
 * transition (duration + cubic-bezier ease) the component's DEFAULT_TRANSITION
 * uses — a standard bezier-easing evaluator, not part of Originkit's own
 * logic, added only because there is no motion library loaded here.
 */
(function (global) {
    "use strict";

    /* ------------------------------------------------- cubic-bezier tween runner
     * Minimal stand-in for motion's `animate(from, to, { type:"tween", ease, duration })`.
     * Standard Newton-Raphson cubic-bezier solve (the same algorithm behind
     * CSS's cubic-bezier() timing functions) — not Originkit-specific, just
     * what is needed to reproduce a `tween` transition without the library.
     */
    function makeBezierEasing(x1, y1, x2, y2) {
        function A(a1, a2) { return 1 - 3 * a2 + 3 * a1; }
        function B(a1, a2) { return 3 * a2 - 6 * a1; }
        function C(a1) { return 3 * a1; }
        function calcBezier(t, a1, a2) { return ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t; }
        function getSlope(t, a1, a2) { return 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1); }
        function getTForX(x) {
            var t = x;
            for (var i = 0; i < 8; i++) {
                var slope = getSlope(t, x1, x2);
                if (slope === 0) break;
                var xEst = calcBezier(t, x1, x2) - x;
                t -= xEst / slope;
            }
            return t;
        }
        return function (x) {
            if (x1 === y1 && x2 === y2) return x;
            if (x <= 0) return 0;
            if (x >= 1) return 1;
            return calcBezier(getTForX(x), y1, y2);
        };
    }

    function animateTween(from, to, opts) {
        var duration = Math.max(0.001, opts.duration || 1) * 1000;
        var ease = opts.ease || [0.33, 1, 0.68, 1];
        var easing = makeBezierEasing(ease[0], ease[1], ease[2], ease[3]);
        var onUpdate = opts.onUpdate || function () {};
        var start = performance.now();
        var raf = 0;
        var stopped = false;

        function tick() {
            if (stopped) return;
            var t = Math.min(1, (performance.now() - start) / duration);
            var p = easing(t);
            onUpdate(from + (to - from) * p);
            if (t < 1) {
                raf = requestAnimationFrame(tick);
            }
        }
        raf = requestAnimationFrame(tick);

        return {
            stop: function () {
                stopped = true;
                cancelAnimationFrame(raf);
            },
        };
    }

    /* ------------------------------------------------------------ constants */
    var DEFAULT_TRANSITION = {
        type: "tween",
        ease: [0.33, 1, 0.68, 1],
        mass: 1,
        damping: 60,
        duration: 1,
        stiffness: 800,
    };
    var FLICK_SCALE = 0.5;
    var CLICK_SLOP = 6;
    var SCALE_NEAR = 1.18;
    var SCALE_FALLOFF = 0.65;
    function scaleAtRatio(ratio) { return SCALE_NEAR - ratio * SCALE_FALLOFF; }
    var FIT_MARGIN = 0.96;
    var CARD_BASE = 220;

    var DEFAULT_IMAGES = [];

    /**
     * createSpinCarousel(host, props) — host is a DOM element that will host
     * the wheel. Returns { destroy() }.
     */
    function createSpinCarousel(host, props) {
        props = props || {};
        var itemsIn = (props.items || []).filter(Boolean);
        var sources = itemsIn.length > 0 ? itemsIn : DEFAULT_IMAGES;
        var background = props.background !== undefined ? props.background : "#0a0a0f";
        var scaleOpt = props.scale !== undefined ? props.scale : 64;
        var aspect = props.aspect !== undefined ? props.aspect : 136;
        var rounded = props.rounded !== undefined ? props.rounded : 24;
        var speed = props.speed !== undefined ? props.speed : 100;
        var transition = props.transition || DEFAULT_TRANSITION;

        var multiplier = sources.length === 0 ? 0 : Math.max(1, Math.ceil(10 / sources.length));
        var CARDS = [];
        for (var m = 0; m < multiplier; m++) {
            for (var j = 0; j < sources.length; j++) {
                CARDS.push({ src: sources[j], id: "img-" + m + "-" + j });
            }
        }

        var anglePerCard = CARDS.length > 0 ? 360 / CARDS.length : 0;
        var cardW = CARD_BASE;
        var cardH = Math.max(1, Math.round((CARD_BASE * aspect) / 100));
        var cardRadius = (Math.min(cardW, cardH) / 2) * (Math.min(100, Math.max(0, rounded)) / 100);

        var radius;
        (function () {
            var total = CARDS.length;
            if (total <= 1) { radius = cardH * 1.2; return; }
            var arcTarget = cardW * 0.65;
            var R = arcTarget / (2 * Math.sin(Math.PI / total));
            radius = Math.max(R, cardH * 1.1);
        })();

        /* -------------------------------------------------------------- DOM */
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.position = "relative";
        host.style.overflow = "hidden";
        host.style.userSelect = "none";
        host.style.touchAction = "none";
        host.style.backgroundColor = background;

        var container = document.createElement("div");
        container.style.position = "absolute";
        container.style.inset = "0";
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.justifyContent = "center";
        container.style.cursor = "grab";
        host.appendChild(container);

        var fitWrap = document.createElement("div");
        fitWrap.style.transformOrigin = "center";
        container.appendChild(fitWrap);

        var carousel = document.createElement("div");
        carousel.style.position = "relative";
        carousel.style.width = "0";
        carousel.style.height = "0";
        carousel.style.display = "flex";
        carousel.style.alignItems = "center";
        carousel.style.justifyContent = "center";
        fitWrap.appendChild(carousel);

        var cardEls = [];
        CARDS.forEach(function (card, index) {
            var baseAngle = (index / CARDS.length) * 360;
            var el = document.createElement("div");
            el.setAttribute("data-index", String(index));
            el.style.position = "absolute";
            el.style.left = -(cardW / 2) + "px";
            el.style.top = -radius + "px";
            el.style.width = cardW + "px";
            el.style.height = cardH + "px";
            el.style.transformOrigin = "50% " + radius + "px";
            el.style.transform = "rotate(" + baseAngle + "deg)";
            el.style.willChange = "transform, opacity, filter";

            var img = document.createElement("img");
            img.src = card.src;
            img.alt = "";
            img.draggable = false;
            img.style.width = "100%";
            img.style.height = "100%";
            img.style.objectFit = "cover";
            img.style.display = "block";
            img.style.borderRadius = cardRadius + "px";
            img.style.pointerEvents = "none";
            img.style.backgroundColor = "#16161e";
            el.appendChild(img);

            carousel.appendChild(el);
            cardEls.push(el);
        });

        /* ------------------------------------------------------------ state */
        var rotationRef = 0;
        var snapAnim = null;
        var isDragging = false;
        var autoPlayTimer = 0;
        var wheelTimeout = 0;
        var containerSize = { w: Math.max(1, host.clientWidth), h: Math.max(1, host.clientHeight) };
        var fit = { scale: 0.65, dx: 0, dy: 0 };

        var dragInfo = { startX: 0, lastX: 0, lastTime: 0, velocity: 0, moved: 0, downIndex: -1 };

        function computeFit() {
            if (containerSize.w === 0 || containerSize.h === 0 || CARDS.length === 0) {
                fit = { scale: 0.65, dx: 0, dy: 0 };
                return;
            }
            var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (var deg = 0; deg < 360; deg += 2) {
                var normalized = deg;
                if (normalized > 180) normalized -= 360;
                var s = scaleAtRatio(Math.abs(normalized) / 180);
                var rad = (deg * Math.PI) / 180;
                var c = Math.cos(rad);
                var sn = Math.sin(rad);
                var xs = [-cardW / 2, cardW / 2];
                var ys = [-radius, -radius + cardH];
                for (var xi = 0; xi < xs.length; xi++) {
                    for (var yi = 0; yi < ys.length; yi++) {
                        var px = xs[xi] * s;
                        var py = ys[yi] * s;
                        var rx = px * c - py * sn;
                        var ry = px * sn + py * c;
                        if (rx < minX) minX = rx;
                        if (rx > maxX) maxX = rx;
                        if (ry < minY) minY = ry;
                        if (ry > maxY) maxY = ry;
                    }
                }
            }
            var boxW = maxX - minX;
            var boxH = maxY - minY;
            var zoom = Math.min(containerSize.w / boxW, containerSize.h / boxH) * FIT_MARGIN * (Math.max(1, scaleOpt) / 100);
            fit = {
                scale: zoom,
                dx: -((minX + maxX) / 2) * zoom,
                dy: -((minY + maxY) / 2) * zoom,
            };
        }

        function applyFit() {
            fitWrap.style.transform = "translate(" + fit.dx + "px, " + fit.dy + "px) scale(" + fit.scale + ")";
        }

        computeFit();
        applyFit();

        var ro = new ResizeObserver(function (entries) {
            var entry = entries[0];
            var w = entry.contentRect.width, h = entry.contentRect.height;
            if (w > 0 && h > 0) {
                containerSize = { w: w, h: h };
                computeFit();
                applyFit();
            }
        });
        ro.observe(host);

        function updateCardScales() {
            var currentRot = rotationRef;
            cardEls.forEach(function (card, index) {
                var baseAngle = index * anglePerCard;
                var cardAngle = baseAngle + currentRot;
                var normalized = cardAngle % 360;
                if (normalized > 180) normalized -= 360;
                if (normalized < -180) normalized += 360;
                var dist = Math.abs(normalized);
                var ratio = dist / 180;
                var sc = scaleAtRatio(ratio);
                var opacity = 1 - ratio * 0.55;
                var brightness = 1 - ratio * 0.65;
                var zIndex = Math.round(1000 - dist);

                card.style.transform = "rotate(" + baseAngle + "deg) scale(" + sc + ")";
                card.style.opacity = String(opacity);
                card.style.filter = "brightness(" + brightness + ")";
                card.style.zIndex = String(zIndex);
            });
        }
        updateCardScales();

        function animateTo(target, scaleFactor) {
            scaleFactor = scaleFactor === undefined ? 1 : scaleFactor;
            if (snapAnim) snapAnim.stop();
            var start = rotationRef;
            var delta = target - start;
            var t = transition;
            var opts;
            if (scaleFactor === 1) {
                opts = t;
            } else {
                opts = {};
                for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) opts[k] = t[k];
                if (typeof t.duration === "number") opts.duration = t.duration * scaleFactor;
                if (typeof t.stiffness === "number") opts.stiffness = t.stiffness / (scaleFactor * scaleFactor);
            }
            snapAnim = animateTween(0, 1, {
                duration: opts.duration,
                ease: opts.ease,
                onUpdate: function (p) {
                    rotationRef = start + delta * p;
                    carousel.style.transform = "rotate(" + rotationRef + "deg)";
                    updateCardScales();
                },
            });
        }

        function navigate(direction) {
            if (CARDS.length === 0) return;
            if (snapAnim) snapAnim.stop();
            var target = rotationRef + anglePerCard * direction * -1;
            var snapped = Math.round(target / anglePerCard) * anglePerCard;
            animateTo(snapped);
        }

        function goToIndex(index) {
            if (CARDS.length === 0) return;
            if (snapAnim) snapAnim.stop();
            var base = -index * anglePerCard;
            var turns = Math.round((rotationRef - base) / 360);
            animateTo(base + turns * 360);
        }

        function onPointerDown(e) {
            if (CARDS.length === 0) return;
            isDragging = true;
            if (snapAnim) snapAnim.stop();
            dragInfo.startX = e.clientX;
            dragInfo.lastX = e.clientX;
            dragInfo.lastTime = Date.now();
            dragInfo.velocity = 0;
            dragInfo.moved = 0;
            var hit = e.target && e.target.closest ? e.target.closest("[data-index]") : null;
            dragInfo.downIndex = hit ? Number(hit.getAttribute("data-index")) : -1;

            try { container.setPointerCapture(e.pointerId); } catch (err) {}
            container.style.cursor = "grabbing";
        }

        function onPointerMove(e) {
            if (!isDragging) return;
            var currentX = e.clientX;
            var deltaX = currentX - dragInfo.lastX;
            var now = Date.now();
            var dt = now - dragInfo.lastTime;
            if (dt > 0) dragInfo.velocity = deltaX / dt;
            dragInfo.moved = Math.abs(currentX - dragInfo.startX);
            rotationRef += deltaX * 0.25;
            carousel.style.transform = "rotate(" + rotationRef + "deg)";
            updateCardScales();
            dragInfo.lastX = currentX;
            dragInfo.lastTime = now;
        }

        function onPointerUp(e) {
            if (!isDragging) return;
            isDragging = false;
            container.style.cursor = "grab";
            if (e && e.pointerId !== undefined) {
                try { container.releasePointerCapture(e.pointerId); } catch (err) {}
            }
            if (dragInfo.moved < CLICK_SLOP && dragInfo.downIndex >= 0) {
                goToIndex(dragInfo.downIndex);
                return;
            }
            var inertiaFactor = 120;
            var projectedDelta = dragInfo.velocity * inertiaFactor;
            var targetRotation = rotationRef + projectedDelta;
            var snapped = Math.round(targetRotation / anglePerCard) * anglePerCard;
            animateTo(snapped);
        }

        function onWheel(e) {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
            e.preventDefault();
            if (snapAnim) snapAnim.stop();
            var delta = e.deltaY * 0.15;
            rotationRef -= delta;
            carousel.style.transform = "rotate(" + rotationRef + "deg)";
            updateCardScales();

            window.clearTimeout(wheelTimeout);
            wheelTimeout = window.setTimeout(function () {
                var snapped = Math.round(rotationRef / anglePerCard) * anglePerCard;
                animateTo(snapped, FLICK_SCALE);
            }, 150);
        }

        container.addEventListener("pointerdown", onPointerDown);
        container.addEventListener("pointermove", onPointerMove);
        container.addEventListener("pointerup", onPointerUp);
        container.addEventListener("pointercancel", onPointerUp);
        container.addEventListener("wheel", onWheel, { passive: false });

        if (speed !== 0 && CARDS.length > 0) {
            var dir = speed < 0 ? -1 : 1;
            var autoPlayInterval = (3000 * 50) / Math.abs(speed);
            autoPlayTimer = window.setInterval(function () {
                if (!isDragging) navigate(dir);
            }, autoPlayInterval);
        }

        function destroy() {
            if (snapAnim) snapAnim.stop();
            clearInterval(autoPlayTimer);
            window.clearTimeout(wheelTimeout);
            ro.disconnect();
            container.removeEventListener("pointerdown", onPointerDown);
            container.removeEventListener("pointermove", onPointerMove);
            container.removeEventListener("pointerup", onPointerUp);
            container.removeEventListener("pointercancel", onPointerUp);
            container.removeEventListener("wheel", onWheel);
            if (host.contains(container)) host.removeChild(container);
        }

        return { destroy: destroy };
    }

    global.createSpinCarousel = createSpinCarousel;
})(window);
