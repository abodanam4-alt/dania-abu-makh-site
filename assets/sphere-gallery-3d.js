/**
 * SPHERE GALLERY 3D — media nodes distributed on a spherical shell around a
 * lit nucleus, wired to it by live line segments.
 *
 * Ported verbatim from the Originkit component (ui/sphere-gallery-3d.tsx,
 * stack: react/css). RAW WebGL, no `three`, no npm dependency of any kind —
 * perspective projection, the YXZ rig, quaternion billboarding, the pointer
 * ray, the sphere tessellation, texture upload are all reproduced exactly as
 * shipped. The ONLY change from the original file is the outer shell: the
 * React component (props/useRef/useEffect/JSX) is replaced with a plain
 * factory function that takes a host <div> and an options object, because
 * this site is static HTML/CSS/JS with no React runtime. Every constant,
 * every formula, every comment explaining a "measured" decision below is
 * unchanged from the original.
 *
 * Interaction (unchanged):
 *   • drag        — camera orbit, yaw/pitch accumulated, pitch clamped,
 *                   inertia on release, bound on `window` so a drag that
 *                   leaves the host still tracks and still releases.
 *   • hover       — magnetic attraction. The pointer is a RAY, not a 2D point:
 *                   each node is pulled toward the closest point on the
 *                   camera ray, so the effect is correct at any orbit angle.
 *   • wheel       — dolly the camera between Min/Max Zoom, damped.
 *   • click       — raycast, open that node's link in a new tab (if any).
 */
(function (global) {
    "use strict";

    /* ------------------------------------------------------------- helpers */
    // stand-in for TS's `??`: only the default kicks in on undefined/null,
    // so a real 0 or "" from options still wins
    function nz(v, d) {
        return v === undefined || v === null ? d : v;
    }

    /* ----------------------------------------------------------------- shaders
     * GLSL ES 1.00, so the same source compiles on a WebGL2 context and on a
     * WebGL1 fallback.
     *
     * One quad per node. The rounded corner is an SDF, not a texture and not a
     * DOM clip: the mask is computed in the fragment shader so it stays exact at
     * every distance and every node scale, with one screen pixel of feather.
     *
     * That feather comes from `uAA`, NOT from `fwidth()`. Derivatives are core in
     * GLSL ES 3.00 but need OES_standard_derivatives on a WebGL1 context, and a
     * shader that fails to compile there takes the whole component with it. The
     * CPU already knows the node's depth and scale, so one pixel in the SDF's own
     * units is exact arithmetic — no extension, no branch.
     */
    var QUAD_VERT =
        "precision highp float;\n" +
        "attribute vec2 aCorner;\n" +
        "uniform mat4 uMVP;\n" +
        "varying vec2 vUv;\n" +
        "void main() {\n" +
        "    vUv = aCorner + 0.5;\n" +
        "    gl_Position = uMVP * vec4(aCorner, 0.0, 1.0);\n" +
        "}\n";

    var QUAD_FRAG =
        "precision highp float;\n" +
        "varying vec2 vUv;\n" +
        "uniform sampler2D uMap;\n" +
        "uniform float uHasTex;\n" +
        "uniform vec2  uHalf;\n" +
        "uniform float uRadius;\n" +
        "uniform float uAA;\n" +
        "uniform float uOpacity;\n" +
        "uniform float uDim;\n" +
        "uniform vec3  uPlaceholder;\n" +
        "float sdRoundBox(vec2 p, vec2 b, float r) {\n" +
        "    vec2 q = abs(p) - b + r;\n" +
        "    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;\n" +
        "}\n" +
        "void main() {\n" +
        "    vec2 p = (vUv - 0.5) * 2.0 * uHalf;\n" +
        "    float sHalf = min(uHalf.x, uHalf.y);\n" +
        "    float t = sHalf > 0.0 ? clamp(uRadius / sHalf, 0.0, 1.0) : 0.0;\n" +
        "    vec2 box = mix(uHalf, vec2(sHalf), t);\n" +
        "    float d = sdRoundBox(p, box, uRadius);\n" +
        "    float aa = max(uAA, 1e-5);\n" +
        "    float mask = 1.0 - smoothstep(-aa, aa, d);\n" +
        "    if (mask <= 0.002) discard;\n" +
        "    vec3 col = mix(uPlaceholder, texture2D(uMap, vUv).rgb, uHasTex);\n" +
        "    col *= uDim;\n" +
        "    float a = mask * uOpacity;\n" +
        "    if (a <= 0.002) discard;\n" +
        "    gl_FragColor = vec4(col * a, a);\n" +
        "}\n";

    var SOLID_VERT =
        "precision highp float;\n" +
        "attribute vec3 aPos;\n" +
        "uniform mat4 uMVP;\n" +
        "uniform float uScale;\n" +
        "void main() {\n" +
        "    gl_Position = uMVP * vec4(aPos * uScale, 1.0);\n" +
        "}\n";

    var SOLID_FRAG =
        "precision mediump float;\n" +
        "uniform vec4 uColor;\n" +
        "void main() {\n" +
        "    gl_FragColor = vec4(uColor.rgb * uColor.a, uColor.a);\n" +
        "}\n";

    /* ---------------------------------------------------------------- constants */
    var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    var BASE_SPIN = 0.22; // rad/sec at Auto Rotate 100
    var SPRING_STIFFNESS = 70; // 1/sec^2 pull toward the magnetic target
    var HOVER_POP = 0.3; // extra scale on a fully captured node
    var BILLBOARD_BLEND = 0.75;
    var RADIUS = 12; // shell radius, world units
    var DAMPING = 0.6; // spring settle, 0-1
    var FOV = 45; // ° vertical
    var MIN_DIST = 18; // wheel dolly clamp, world units, at Scale 100
    var MAX_DIST = 70;
    var REST_DIST_MUL = 2.8; // resting dolly = RADIUS * this, at Scale 100
    var MAX_BRANCHES = 60;
    var ZOOM_GAIN = 1;
    var ORBIT_SPEED = 0.25; // ° of camera swing per dragged pixel
    var ORBIT_DAMPING = 0.6;
    var ORBIT_LIMIT = 70; // ° pitch clamp either side of level
    var DEPTH_FLOOR = 0.32; // how dark the far side of the shell goes
    var ZOOM_RATE = 9; // 1/sec camera dolly damping
    var CLICK_SLOP_PX = 5;
    var CLICK_MS = 450;
    var PLACEHOLDER = "#1b1b20";
    var SPHERE_W = 32; // core tessellation
    var SPHERE_H = 24;
    var NEAR = 0.1;
    var FAR = 2000;

    /** stable per-index jitter — a seeded hash, never Math.random, so the shell
     * does not reshuffle itself on every re-render */
    function hash01(i) {
        var s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
        return s - Math.floor(s);
    }

    function clamp(v, lo, hi) {
        return v < lo ? lo : v > hi ? hi : v;
    }

    /* -------------------------------------------------------------------- colour */
    function parseColor(input, fallback) {
        if (!input) return fallback.slice();
        var s = String(input).trim();

        var m = s.match(/^rgba?\(([^)]+)\)$/i);
        if (m) {
            var parts = m[1].split(/[,\s/]+/).filter(Boolean);
            var ch = function (t) {
                return t.indexOf("%") >= 0 ? parseFloat(t) / 100 : parseFloat(t) / 255;
            };
            var r = ch(parts[0] !== undefined ? parts[0] : "0");
            var g = ch(parts[1] !== undefined ? parts[1] : "0");
            var b = ch(parts[2] !== undefined ? parts[2] : "0");
            var a = parts[3] === undefined ? 1 : parseFloat(parts[3]);
            if ([r, g, b, a].some(function (v) { return !isFinite(v); })) return fallback.slice();
            return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1), clamp(a, 0, 1)];
        }

        var h = s.replace(/^#/, "");
        if (h.length === 3 || h.length === 4) {
            h = h.split("").map(function (c) { return c + c; }).join("");
        }
        if (h.length !== 6 && h.length !== 8) return fallback.slice();
        var n = parseInt(h, 16);
        if (!isFinite(n)) return fallback.slice();
        if (h.length === 6) {
            return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
        }
        return [
            ((n >>> 24) & 255) / 255,
            ((n >>> 16) & 255) / 255,
            ((n >>> 8) & 255) / 255,
            (n & 255) / 255,
        ];
    }

    /* ---------------------------------------------------------------- math
     * Column-major mat4, GL order.
     */
    function mat4() {
        var m = new Float32Array(16);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
    }

    /** vertical-FOV perspective, identical to three's PerspectiveCamera */
    function perspective(out, fovyRad, aspect) {
        var f = 1 / Math.tan(fovyRad / 2);
        out.fill(0);
        out[0] = f / aspect;
        out[5] = f;
        out[10] = (FAR + NEAR) / (NEAR - FAR);
        out[11] = -1;
        out[14] = (2 * FAR * NEAR) / (NEAR - FAR);
        return out;
    }

    function mul(out, a, b) {
        for (var c = 0; c < 4; c++) {
            var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
            out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
            out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
            out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return out;
    }

    /**
     * The rig's rotation, Euler order YXZ with z = 0 — i.e. Ry(yaw) · Rx(pitch).
     * That order is what makes a drag read as a turntable and not as a tumbling
     * object. Written into a mat4 whose translation column is the camera dolly.
     */
    function rigView(out, yaw, pitch, camZ) {
        var a = Math.cos(pitch), b = Math.sin(pitch);
        var c = Math.cos(yaw), d = Math.sin(yaw);
        out[0] = c; out[1] = 0; out[2] = -d; out[3] = 0;
        out[4] = d * b; out[5] = a; out[6] = c * b; out[7] = 0;
        out[8] = a * d; out[9] = -b; out[10] = a * c; out[11] = 0;
        out[12] = 0; out[13] = 0; out[14] = -camZ; out[15] = 1;
        return out;
    }

    /** the same rotation as a plain 3x3, row-major, for the CPU-side vector work */
    function rigBasis(yaw, pitch) {
        var a = Math.cos(pitch), b = Math.sin(pitch);
        var c = Math.cos(yaw), d = Math.sin(yaw);
        return [c, d * b, a * d, 0, a, -b, -d, c * b, a * c];
    }

    /** R · v */
    function applyBasis(R, x, y, z, out) {
        out[0] = R[0] * x + R[1] * y + R[2] * z;
        out[1] = R[3] * x + R[4] * y + R[5] * z;
        out[2] = R[6] * x + R[7] * y + R[8] * z;
    }

    /** Rᵀ · v — world -> rig-local, the inverse of a pure rotation */
    function applyBasisT(R, x, y, z, out) {
        out[0] = R[0] * x + R[3] * y + R[6] * z;
        out[1] = R[1] * x + R[4] * y + R[7] * z;
        out[2] = R[2] * x + R[5] * y + R[8] * z;
    }

    /** rig quaternion for Euler YXZ with z = 0, i.e. qYaw · qPitch */
    function quatFromYawPitch(yaw, pitch, out) {
        var cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
        var cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
        out[0] = cy * sx;
        out[1] = sy * cx;
        out[2] = -sy * sx;
        out[3] = cy * cx;
        return out;
    }

    /**
     * Shortest rotation taking +Z onto `dir` (a unit vector). three's
     * setFromUnitVectors, specialised to vFrom = (0,0,1).
     */
    function quatFromZTo(dx, dy, dz, out) {
        var r = dz + 1;
        var x, y, z, w;
        if (r < 1e-6) {
            x = 0; y = -1; z = 0; w = 0;
        } else {
            x = -dy; y = dx; z = 0; w = r;
        }
        var len = Math.hypot(x, y, z, w) || 1;
        out[0] = x / len; out[1] = y / len; out[2] = z / len; out[3] = w / len;
        return out;
    }

    /** three's Quaternion.slerp, including the shortest-path flip */
    function quatSlerp(a, b, t, out) {
        if (t <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3]; return out; }
        if (t >= 1) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; out[3] = b[3]; return out; }

        var ax = a[0], ay = a[1], az = a[2], aw = a[3];
        var bx = b[0], by = b[1], bz = b[2], bw = b[3];

        var cosHalf = aw * bw + ax * bx + ay * by + az * bz;
        if (cosHalf < 0) { cosHalf = -cosHalf; bx = -bx; by = -by; bz = -bz; bw = -bw; }

        if (cosHalf >= 1) { out[0] = ax; out[1] = ay; out[2] = az; out[3] = aw; return out; }

        var sqrSin = 1 - cosHalf * cosHalf;
        if (sqrSin <= Number.EPSILON) {
            var s = 1 - t;
            out[0] = s * ax + t * bx;
            out[1] = s * ay + t * by;
            out[2] = s * az + t * bz;
            out[3] = s * aw + t * bw;
            var len2 = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
            out[0] /= len2; out[1] /= len2; out[2] /= len2; out[3] /= len2;
            return out;
        }

        var sinHalf = Math.sqrt(sqrSin);
        var half = Math.atan2(sinHalf, cosHalf);
        var ra = Math.sin((1 - t) * half) / sinHalf;
        var rb = Math.sin(t * half) / sinHalf;
        out[0] = ax * ra + bx * rb;
        out[1] = ay * ra + by * rb;
        out[2] = az * ra + bz * rb;
        out[3] = aw * ra + bw * rb;
        return out;
    }

    /** position · rotation · scale, straight into a column-major mat4 */
    function compose(out, px, py, pz, q, sx, sy, sz) {
        var x = q[0], y = q[1], z = q[2], w = q[3];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, xy = x * y2, xz = x * z2;
        var yy = y * y2, yz = y * z2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;

        out[0] = (1 - (yy + zz)) * sx;
        out[1] = (xy + wz) * sx;
        out[2] = (xz - wy) * sx;
        out[3] = 0;
        out[4] = (xy - wz) * sy;
        out[5] = (1 - (xx + zz)) * sy;
        out[6] = (yz + wx) * sy;
        out[7] = 0;
        out[8] = (xz + wy) * sz;
        out[9] = (yz - wx) * sz;
        out[10] = (1 - (xx + yy)) * sz;
        out[11] = 0;
        out[12] = px;
        out[13] = py;
        out[14] = pz;
        out[15] = 1;
        return out;
    }

    /** the quad's right / up / normal axes, i.e. the rotation matrix's columns */
    function quatAxes(q, right, up, normal) {
        var x = q[0], y = q[1], z = q[2], w = q[3];
        var x2 = x + x, y2 = y + y, z2 = z + z;
        var xx = x * x2, xy = x * y2, xz = x * z2;
        var yy = y * y2, yz = y * z2, zz = z * z2;
        var wx = w * x2, wy = w * y2, wz = w * z2;
        right[0] = 1 - (yy + zz); right[1] = xy + wz; right[2] = xz - wy;
        up[0] = xy - wz; up[1] = 1 - (xx + zz); up[2] = yz + wx;
        normal[0] = xz + wy; normal[1] = yz - wx; normal[2] = 1 - (xx + yy);
    }

    /* ------------------------------------------------------------ core geometry
     * three's SphereGeometry(1, 32, 24), generated inline. The halo reuses the
     * same positions with a (non-deduped, see below) edge index.
     */
    function buildSphere(widthSeg, heightSeg) {
        var pos = [];
        var grid = [];
        var index = 0;

        for (var iy = 0; iy <= heightSeg; iy++) {
            var row = [];
            var v = iy / heightSeg;
            var theta = v * Math.PI;
            for (var ix = 0; ix <= widthSeg; ix++) {
                var u = ix / widthSeg;
                var phi = u * Math.PI * 2;
                pos.push(
                    -Math.cos(phi) * Math.sin(theta),
                    Math.cos(theta),
                    Math.sin(phi) * Math.sin(theta)
                );
                row.push(index++);
            }
            grid.push(row);
        }

        var tris = [];
        for (var iy2 = 0; iy2 < heightSeg; iy2++) {
            for (var ix2 = 0; ix2 < widthSeg; ix2++) {
                var a = grid[iy2][ix2 + 1];
                var b = grid[iy2][ix2];
                var c = grid[iy2 + 1][ix2];
                var d = grid[iy2 + 1][ix2 + 1];
                if (iy2 !== 0) tris.push(a, b, d);
                if (iy2 !== heightSeg - 1) tris.push(b, c, d);
            }
        }

        // Three edges per triangle, NOT a deduped edge set — shared edges are
        // drawn twice, and under additive blending that is exactly a 2x
        // brighter lattice (measured at 1.85-1.90x), which is the shipped look.
        var edges = [];
        for (var i = 0; i < tris.length; i += 3) {
            var ea = tris[i], eb = tris[i + 1], ec = tris[i + 2];
            edges.push(ea, eb, eb, ec, ec, ea);
        }

        return {
            positions: new Float32Array(pos),
            tris: new Uint16Array(tris),
            edges: new Uint16Array(edges),
        };
    }

    function makeNode() {
        return { ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0, q: [0, 0, 0, 1], hx: 0, hy: 0 };
    }

    function compile(gl, type, src) {
        var sh = gl.createShader(type);
        if (!sh) return null;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("[SphereGallery3D] shader", gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }

    function link(gl, vertSrc, fragSrc) {
        var v = compile(gl, gl.VERTEX_SHADER, vertSrc);
        var f = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
        if (!v || !f) return null;
        var p = gl.createProgram();
        if (!p) return null;
        gl.attachShader(p, v);
        gl.attachShader(p, f);
        gl.linkProgram(p);
        gl.deleteShader(v);
        gl.deleteShader(f);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.error("[SphereGallery3D] link", gl.getProgramInfoLog(p));
            gl.deleteProgram(p);
            return null;
        }
        return p;
    }

    /* -------------------------------------------------------------- component
     * createSphereGallery3D(host, props) — host is a DOM element that will
     * receive the canvas (position: relative is applied to it); props mirrors
     * the original component's props exactly. Returns { destroy() }.
     */
    function createSphereGallery3D(host, props) {
        props = props || {};
        var images = props.images && props.images.length ? props.images : null;
        var branchesProp = nz(props.branches, 34);
        var background = nz(props.background, "#000000");
        var scale = nz(props.scale, 60);
        var size = nz(props.size, 28);
        var scatter = nz(props.scatter, 0);
        var speed = nz(props.speed, 18);
        var direction = nz(props.direction, "counterclockwise");
        var hover = nz(props.hover, 200);
        var rounded = nz(props.rounded, 18);
        var core = props.core || { coreSize: 24, coreColor: "#FFFFFF59", lineColor: "#FFFFFF59" };

        var items = images || [{ image: "", link: "" }];
        var branches = clamp(Math.round(branchesProp), 1, MAX_BRANCHES);

        host.style.position = "relative";
        host.style.overflow = "hidden";
        host.style.background = background;
        host.style.isolation = "isolate";

        var canvas = document.createElement("canvas");
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        host.appendChild(canvas);

        var radius = RADIUS;
        var coreColor = nz(core.coreColor, "#7ab8ffff");
        var lineColor = nz(core.lineColor, "#4a6a9959");
        var coreAlpha = parseColor(coreColor, [0.48, 0.72, 1, 1])[3];
        var lineAlpha = parseColor(lineColor, [0.29, 0.42, 0.6, 0.35])[3];
        var spinSign = direction === "clockwise" ? -1 : 1;

        var live = {
            count: branches,
            radius: radius,
            depthRand: clamp(scatter / 100, 0, 1),
            itemSize: radius * clamp(size / 100, 0.01, 2),
            coreColor: coreColor,
            coreSize: radius * clamp(nz(core.coreSize, 16) / 100, 0, 1),
            coreGlow: coreAlpha,
            lineColor: lineColor,
            lineOpacity: lineAlpha,
            rounded: clamp(rounded / 100, 0, 1),
            spin: (BASE_SPIN * speed * spinSign) / 50,
            force: clamp(hover / 100, 0, 3),
            hoverDist: radius * clamp((hover / 100) * 0.35, 0, 3),
            scale: clamp(scale / 100, 0.2, 4),
            minZoom: MIN_DIST,
            maxZoom: MAX_DIST,
            zoomGain: ZOOM_GAIN,
            orbitSpeed: ORBIT_SPEED,
            orbitDamping: ORBIT_DAMPING,
            orbitLimit: ORBIT_LIMIT,
        };

        var links = [];
        for (var li = 0; li < branches; li++) {
            links.push((items[li % items.length] && items[li % items.length].link) || "");
        }

        /* -------------------------------------------------------------- media */
        var media = items.map(function () {
            return { image: null, aspect: 1, texture: null, applied: false };
        });
        var graveyard = [];
        var mediaAlive = true;
        items.forEach(function (item, i) {
            var url = item && item.image;
            if (!url) return;
            var img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = function () {
                if (!mediaAlive) return;
                media[i].image = img;
                media[i].aspect = (img.naturalWidth || 1) / Math.max(1, img.naturalHeight || 1);
            };
            img.onerror = function () {
                /* leave the placeholder fill */
            };
            img.src = url;
        });

        /* ------------------------------------------------------------ GL setup */
        var attrs = {
            antialias: true,
            alpha: true,
            premultipliedAlpha: true,
            depth: true,
            powerPreference: "high-performance",
        };
        var gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs) || canvas.getContext("experimental-webgl", attrs);

        if (!gl) {
            console.error("[SphereGallery3D] WebGL unavailable");
            return { destroy: function () { mediaAlive = false; } };
        }

        var isGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
        var aniso = gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");

        var quadProg = link(gl, QUAD_VERT, QUAD_FRAG);
        var solidProg = link(gl, SOLID_VERT, SOLID_FRAG);
        if (!quadProg || !solidProg) {
            return { destroy: function () { mediaAlive = false; } };
        }

        var qLoc = {
            aCorner: gl.getAttribLocation(quadProg, "aCorner"),
            uMVP: gl.getUniformLocation(quadProg, "uMVP"),
            uMap: gl.getUniformLocation(quadProg, "uMap"),
            uHasTex: gl.getUniformLocation(quadProg, "uHasTex"),
            uHalf: gl.getUniformLocation(quadProg, "uHalf"),
            uRadius: gl.getUniformLocation(quadProg, "uRadius"),
            uAA: gl.getUniformLocation(quadProg, "uAA"),
            uOpacity: gl.getUniformLocation(quadProg, "uOpacity"),
            uDim: gl.getUniformLocation(quadProg, "uDim"),
            uPlaceholder: gl.getUniformLocation(quadProg, "uPlaceholder"),
        };
        var sLoc = {
            aPos: gl.getAttribLocation(solidProg, "aPos"),
            uMVP: gl.getUniformLocation(solidProg, "uMVP"),
            uScale: gl.getUniformLocation(solidProg, "uScale"),
            uColor: gl.getUniformLocation(solidProg, "uColor"),
        };

        var quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
            gl.STATIC_DRAW
        );

        var ball = buildSphere(SPHERE_W, SPHERE_H);
        var ballBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf);
        gl.bufferData(gl.ARRAY_BUFFER, ball.positions, gl.STATIC_DRAW);
        var ballTri = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ballTri);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ball.tris, gl.STATIC_DRAW);
        var ballEdge = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ballEdge);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ball.edges, gl.STATIC_DRAW);

        var lineBuf = gl.createBuffer();
        var lineData = new Float32Array(0);
        function ensureLines(n) {
            if (lineData.length === n * 6) return;
            lineData = new Float32Array(n * 6);
            gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
            gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
        }

        var white = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, white);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        function isPOT(v) { return (v & (v - 1)) === 0 && v > 0; }

        function upload(img) {
            var tex = gl.createTexture();
            if (!tex) return null;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, isGL2 ? gl.SRGB8_ALPHA8 : gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            var mip = isGL2 || (isPOT(img.naturalWidth) && isPOT(img.naturalHeight));
            if (mip) {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
                if (aniso) {
                    var max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
                    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max || 1));
                }
            } else {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }
            return tex;
        }

        var vw = 1, vh = 1;
        function resize() {
            var w = Math.max(1, host.clientWidth);
            var h = Math.max(1, host.clientHeight);
            var dpr = Math.min(2, window.devicePixelRatio || 1);
            vw = Math.max(1, Math.round(w * dpr));
            vh = Math.max(1, Math.round(h * dpr));
            if (canvas.width !== vw) canvas.width = vw;
            if (canvas.height !== vh) canvas.height = vh;
        }
        resize();
        var ro = new ResizeObserver(resize);
        ro.observe(host);

        var pointer = { nx: 0, ny: 0, inside: false, dragging: false, lastX: 0, lastY: 0, downX: 0, downY: 0, downAt: 0 };

        var orbit = {
            yaw: 0, pitch: 0, yawVel: 0, pitchVel: 0, spin: 0,
            zoom: clamp(live.radius * REST_DIST_MUL, live.minZoom, live.maxZoom),
            zoomTarget: 0,
        };
        orbit.zoomTarget = orbit.zoom;

        var camDist = orbit.zoom / live.scale;

        var nodes = [];
        function setNdc(e) {
            var r = host.getBoundingClientRect();
            pointer.nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
            pointer.ny = -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1;
        }

        var rayO = [0, 0, 0];
        var rayD = [0, 0, -1];
        var rayOL = [0, 0, 0];
        var rayDL = [0, 0, -1];
        var tmpA = [0, 0, 0];
        var axR = [0, 0, 0];
        var axU = [0, 0, 0];
        var axN = [0, 0, 0];

        function buildRay(camZ, fovRad, aspect) {
            var th = Math.tan(fovRad / 2);
            var dx = pointer.nx * th * aspect;
            var dy = pointer.ny * th;
            var dz = -1;
            var len = Math.hypot(dx, dy, dz) || 1;
            rayO[0] = 0; rayO[1] = 0; rayO[2] = camZ;
            rayD[0] = dx / len; rayD[1] = dy / len; rayD[2] = dz / len;
        }

        function hitTest(R) {
            applyBasisT(R, rayO[0], rayO[1], rayO[2], rayOL);
            applyBasisT(R, rayD[0], rayD[1], rayD[2], rayDL);

            var best = -1;
            var bestT = Infinity;
            for (var i = 0; i < nodes.length; i++) {
                var nd = nodes[i];
                quatAxes(nd.q, axR, axU, axN);
                var denom = rayDL[0] * axN[0] + rayDL[1] * axN[1] + rayDL[2] * axN[2];
                if (Math.abs(denom) < 1e-8) continue;
                var ox = nd.px - rayOL[0];
                var oy = nd.py - rayOL[1];
                var oz = nd.pz - rayOL[2];
                var t = (ox * axN[0] + oy * axN[1] + oz * axN[2]) / denom;
                if (t <= 0 || t >= bestT) continue;
                var hx = rayOL[0] + rayDL[0] * t - nd.px;
                var hy = rayOL[1] + rayDL[1] * t - nd.py;
                var hz = rayOL[2] + rayDL[2] * t - nd.pz;
                var u = hx * axR[0] + hy * axR[1] + hz * axR[2];
                var v = hx * axU[0] + hy * axU[1] + hz * axU[2];
                if (Math.abs(u) > nd.hx || Math.abs(v) > nd.hy) continue;
                bestT = t;
                best = i;
            }
            return best;
        }

        var frameBasis = rigBasis(0, 0);

        function onPointerDown(e) {
            setNdc(e);
            pointer.inside = true;
            pointer.dragging = true;
            pointer.lastX = e.clientX;
            pointer.lastY = e.clientY;
            pointer.downX = e.clientX;
            pointer.downY = e.clientY;
            pointer.downAt = performance.now();
            orbit.yawVel = 0;
            orbit.pitchVel = 0;
            canvas.style.cursor = "grabbing";
        }

        function onPointerMove(e) {
            var r = host.getBoundingClientRect();
            var inBox = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
            pointer.inside = inBox || pointer.dragging;
            if (pointer.inside) setNdc(e);

            if (!pointer.dragging) {
                if (inBox) {
                    buildRay(camDist, (FOV * Math.PI) / 180, vw / vh);
                    var idx = hitTest(frameBasis);
                    canvas.style.cursor = idx >= 0 && links[idx] ? "pointer" : "grab";
                }
                return;
            }

            var dx = e.clientX - pointer.lastX;
            var dy = e.clientY - pointer.lastY;
            pointer.lastX = e.clientX;
            pointer.lastY = e.clientY;

            var L = live;
            orbit.yaw += (dx * L.orbitSpeed * Math.PI) / 180;
            orbit.pitch += (dy * L.orbitSpeed * Math.PI) / 180;
            var lim = (L.orbitLimit * Math.PI) / 180;
            orbit.pitch = clamp(orbit.pitch, -lim, lim);

            orbit.yawVel = dx * L.orbitSpeed * 60;
            orbit.pitchVel = dy * L.orbitSpeed * 60;
        }

        function release(e) {
            if (!pointer.dragging) return;
            pointer.dragging = false;
            canvas.style.cursor = "grab";

            var dt0 = performance.now() - pointer.downAt;
            var dist = Math.abs(e.clientX - pointer.downX) + Math.abs(e.clientY - pointer.downY);

            if (dist <= CLICK_SLOP_PX && dt0 <= CLICK_MS) {
                orbit.yawVel = 0;
                orbit.pitchVel = 0;
                setNdc(e);
                buildRay(camDist, (FOV * Math.PI) / 180, vw / vh);
                var idx = hitTest(frameBasis);
                var url = idx >= 0 ? links[idx] : "";
                if (url) window.open(url, "_blank", "noopener,noreferrer");
            }
        }

        function onLeave() {
            if (!pointer.dragging) pointer.inside = false;
        }

        function onWheel(e) {
            e.preventDefault();
            var L = live;
            orbit.zoomTarget = clamp(orbit.zoomTarget + e.deltaY * 0.02 * L.zoomGain, L.minZoom, L.maxZoom);
        }

        canvas.style.cursor = "grab";
        canvas.style.touchAction = "none";
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointerleave", onLeave);
        canvas.addEventListener("wheel", onWheel, { passive: false });
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);

        var proj = mat4();
        var view = mat4();
        var viewProj = mat4();
        var model = mat4();
        var mvp = mat4();
        var qRig = [0, 0, 0, 1];
        var qCamLocal = [0, 0, 0, 1];
        var qRadial = [0, 0, 0, 1];
        var forwardLocal = [0, 0, -1];
        var placeholderRGB = parseColor(PLACEHOLDER, [0, 0, 0, 1]);
        var order = [];

        gl.clearColor(0, 0, 0, 0);
        gl.enable(gl.DEPTH_TEST);

        var raf = 0;
        var prev = performance.now();
        var running = true;

        function drawHalo() {
            var L = live;
            if (L.coreGlow <= 0.002) return;
            var c = parseColor(L.coreColor, [0.48, 0.72, 1, 1]);
            gl.useProgram(solidProg);
            gl.uniformMatrix4fv(sLoc.uMVP, false, viewProj);
            gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf);
            gl.enableVertexAttribArray(sLoc.aPos);
            gl.vertexAttribPointer(sLoc.aPos, 3, gl.FLOAT, false, 0, 0);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.uniform1f(sLoc.uScale, Math.max(0.001, L.coreSize) * 1.45);
            gl.uniform4f(sLoc.uColor, c[0], c[1], c[2], L.coreGlow);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ballEdge);
            gl.drawElements(gl.LINES, ball.edges.length, gl.UNSIGNED_SHORT, 0);
            gl.disableVertexAttribArray(sLoc.aPos);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }

        function frame() {
            if (!running) return;
            raf = requestAnimationFrame(frame);

            var now = performance.now();
            var dt = Math.min(0.05, (now - prev) / 1000);
            prev = now;

            var L = live;
            var n = Math.max(0, L.count | 0);
            function mediaFor(i) { return media.length ? media[i % media.length] : undefined; }

            while (graveyard.length) gl.deleteTexture(graveyard.pop());

            while (nodes.length < n) nodes.push(makeNode());
            if (nodes.length > n) nodes.length = n;
            ensureLines(n);

            gl.viewport(0, 0, vw, vh);
            gl.depthMask(true);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            var lo = Math.min(L.minZoom, L.maxZoom);
            var hi = Math.max(L.minZoom, L.maxZoom);
            orbit.zoomTarget = clamp(orbit.zoomTarget, lo, hi);
            orbit.zoom += (orbit.zoomTarget - orbit.zoom) * (1 - Math.exp(-ZOOM_RATE * dt));
            camDist = orbit.zoom / Math.max(0.001, L.scale);

            var fovRad = (FOV * Math.PI) / 180;
            var aspect = vw / vh;
            perspective(proj, fovRad, aspect);

            if (!pointer.dragging) {
                var keep = L.orbitDamping <= 0 ? 0 : Math.exp((-6 / Math.max(0.001, L.orbitDamping)) * dt);
                orbit.yaw += ((orbit.yawVel * dt * Math.PI) / 180) * keep;
                orbit.pitch += ((orbit.pitchVel * dt * Math.PI) / 180) * keep;
                orbit.yawVel *= keep;
                orbit.pitchVel *= keep;
                var lim2 = (L.orbitLimit * Math.PI) / 180;
                orbit.pitch = clamp(orbit.pitch, -lim2, lim2);
            }
            orbit.spin += L.spin * dt;
            if (orbit.spin > Math.PI * 2) orbit.spin -= Math.PI * 2;

            var yaw = orbit.spin + orbit.yaw;
            var pitch = orbit.pitch;
            rigView(view, yaw, pitch, camDist);
            mul(viewProj, proj, view);

            var R = rigBasis(yaw, pitch);
            frameBasis = R;
            quatFromYawPitch(yaw, pitch, qRig);
            qCamLocal[0] = -qRig[0];
            qCamLocal[1] = -qRig[1];
            qCamLocal[2] = -qRig[2];
            qCamLocal[3] = qRig[3];
            applyBasisT(R, 0, 0, -1, forwardLocal);

            var coreR = Math.max(0.001, L.coreSize);

            gl.useProgram(solidProg);
            gl.uniformMatrix4fv(sLoc.uMVP, false, viewProj);
            gl.bindBuffer(gl.ARRAY_BUFFER, ballBuf);
            gl.enableVertexAttribArray(sLoc.aPos);
            gl.vertexAttribPointer(sLoc.aPos, 3, gl.FLOAT, false, 0, 0);

            if (L.coreSize > 0.001) {
                var cc = parseColor(L.coreColor, [0.48, 0.72, 1, 1]);
                gl.disable(gl.BLEND);
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                gl.depthMask(true);
                gl.uniform1f(sLoc.uScale, coreR);
                gl.uniform4f(sLoc.uColor, cc[0], cc[1], cc[2], 1);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ballTri);
                gl.drawElements(gl.TRIANGLES, ball.tris.length, gl.UNSIGNED_SHORT, 0);
                gl.disable(gl.CULL_FACE);
            }
            gl.disableVertexAttribArray(sLoc.aPos);

            gl.enable(gl.BLEND);
            gl.depthMask(false);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

            if (!n) {
                gl.disableVertexAttribArray(sLoc.aPos);
                drawHalo();
                return;
            }

            var hovering = pointer.inside && L.force > 0 && L.hoverDist > 0;
            if (hovering) buildRay(camDist, fovRad, aspect);

            var worldPerPixel = (2 * Math.tan(fovRad / 2)) / vh;

            for (var i = 0; i < n; i++) {
                var nd = nodes[i];

                var y = 1 - (2 * (i + 0.5)) / n;
                var rr = Math.sqrt(Math.max(0, 1 - y * y));
                var th = GOLDEN_ANGLE * i;
                var jitter = 1 + (hash01(i) - 0.5) * L.depthRand;
                var Rr = L.radius * jitter;

                var bx = Math.cos(th) * rr * Rr;
                var by = y * Rr;
                var bz = Math.sin(th) * rr * Rr;

                var capture = 0;
                var tx = 0, ty = 0, tz = 0;
                if (hovering) {
                    applyBasis(R, bx, by, bz, tmpA);
                    var wx = tmpA[0], wy = tmpA[1], wz = tmpA[2];
                    var t = Math.max(0, (wx - rayO[0]) * rayD[0] + (wy - rayO[1]) * rayD[1] + (wz - rayO[2]) * rayD[2]);
                    var cx = rayO[0] + rayD[0] * t;
                    var cy = rayO[1] + rayD[1] * t;
                    var cz = rayO[2] + rayD[2] * t;
                    var d = Math.hypot(cx - wx, cy - wy, cz - wz);
                    if (d < L.hoverDist) {
                        var u = 1 - d / L.hoverDist;
                        capture = u * u * (3 - 2 * u);
                        applyBasisT(R, cx - wx, cy - wy, cz - wz, tmpA);
                        var k = capture * L.force;
                        tx = tmpA[0] * k;
                        ty = tmpA[1] * k;
                        tz = tmpA[2] * k;
                        var pop = -k * L.radius * 0.12;
                        tx += forwardLocal[0] * pop;
                        ty += forwardLocal[1] * pop;
                        tz += forwardLocal[2] * pop;
                    }
                }

                var damp = 2 + DAMPING * 16;
                nd.vx += (tx - nd.ox) * SPRING_STIFFNESS * dt;
                nd.vy += (ty - nd.oy) * SPRING_STIFFNESS * dt;
                nd.vz += (tz - nd.oz) * SPRING_STIFFNESS * dt;
                var decay = Math.exp(-damp * dt);
                nd.vx *= decay; nd.vy *= decay; nd.vz *= decay;
                nd.ox += nd.vx * dt; nd.oy += nd.vy * dt; nd.oz += nd.vz * dt;

                var px = bx + nd.ox;
                var py = by + nd.oy;
                var pz = bz + nd.oz;
                nd.px = px; nd.py = py; nd.pz = pz;

                var radLen = Math.hypot(px, py, pz) || 1;
                quatFromZTo(px / radLen, py / radLen, pz / radLen, qRadial);
                quatSlerp(qRadial, qCamLocal, BILLBOARD_BLEND, nd.q);

                var m = mediaFor(i);
                var aspectI = (m && m.aspect) || 1;
                var s = L.itemSize * (1 + HOVER_POP * capture);
                nd.hx = (s * aspectI) / 2;
                nd.hy = s / 2;

                order[i] = i;
            }
            order.length = n;

            function depthOf(nd2) { return R[6] * nd2.px + R[7] * nd2.py + R[8] * nd2.pz; }
            order.sort(function (a, b) { return depthOf(nodes[a]) - depthOf(nodes[b]); });

            var split = 0;
            while (split < n && depthOf(nodes[order[split]]) < 0) split++;

            for (var o = 0; o < n; o++) {
                var ndl = nodes[order[o]];
                var len = Math.hypot(ndl.px, ndl.py, ndl.pz) || 1;
                var k2 = coreR / len;
                lineData[o * 6 + 0] = ndl.px * k2;
                lineData[o * 6 + 1] = ndl.py * k2;
                lineData[o * 6 + 2] = ndl.pz * k2;
                lineData[o * 6 + 3] = ndl.px;
                lineData[o * 6 + 4] = ndl.py;
                lineData[o * 6 + 5] = ndl.pz;
            }
            if (L.lineOpacity > 0.002) {
                gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, lineData);
            }

            function drawStrings(from, count) {
                if (count <= 0 || L.lineOpacity <= 0.002) return;
                var c = parseColor(L.lineColor, [0.29, 0.42, 0.6, 1]);
                gl.useProgram(solidProg);
                gl.uniformMatrix4fv(sLoc.uMVP, false, viewProj);
                gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
                gl.enableVertexAttribArray(sLoc.aPos);
                gl.vertexAttribPointer(sLoc.aPos, 3, gl.FLOAT, false, 0, 0);
                gl.uniform1f(sLoc.uScale, 1);
                gl.uniform4f(sLoc.uColor, c[0], c[1], c[2], L.lineOpacity);
                gl.drawArrays(gl.LINES, from * 2, count * 2);
                gl.disableVertexAttribArray(sLoc.aPos);
            }

            function beginQuads() {
                gl.useProgram(quadProg);
                gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
                gl.enableVertexAttribArray(qLoc.aCorner);
                gl.vertexAttribPointer(qLoc.aCorner, 2, gl.FLOAT, false, 0, 0);
                gl.uniform1i(qLoc.uMap, 0);
                gl.uniform3f(qLoc.uPlaceholder, placeholderRGB[0], placeholderRGB[1], placeholderRGB[2]);
                gl.uniform1f(qLoc.uOpacity, 1);
                gl.activeTexture(gl.TEXTURE0);
            }

            function drawQuads(from, to) {
                for (var o2 = from; o2 < to; o2++) {
                    var i2 = order[o2];
                    var nd3 = nodes[i2];
                    var m2 = mediaFor(i2);

                    if (m2 && m2.image && !m2.texture) {
                        m2.texture = upload(m2.image);
                        m2.applied = false;
                        m2.image = null;
                    }

                    var aspectI2 = (m2 && m2.aspect) || 1;
                    var hasTex = m2 && m2.texture ? 1 : 0;
                    gl.bindTexture(gl.TEXTURE_2D, hasTex ? m2.texture : white);
                    gl.uniform1f(qLoc.uHasTex, hasTex);
                    if (hasTex) {
                        gl.uniform2f(qLoc.uHalf, aspectI2 / 2, 0.5);
                        gl.uniform1f(qLoc.uRadius, L.rounded * Math.min(aspectI2 / 2, 0.5));
                    } else {
                        gl.uniform2f(qLoc.uHalf, 0.5, 0.5);
                        gl.uniform1f(qLoc.uRadius, L.rounded * 0.5);
                    }

                    var sy = nd3.hy * 2;
                    var sx = nd3.hx * 2;
                    compose(model, nd3.px, nd3.py, nd3.pz, nd3.q, sx, sy, 1);
                    mul(mvp, viewProj, model);
                    gl.uniformMatrix4fv(qLoc.uMVP, false, mvp);

                    var depth = R[6] * nd3.px + R[7] * nd3.py + R[8] * nd3.pz;
                    var tt = clamp((depth + L.radius) / (2 * L.radius), 0, 1);
                    gl.uniform1f(qLoc.uDim, DEPTH_FLOOR + (1 - DEPTH_FLOOR) * tt);

                    var dist2 = Math.max(0.001, camDist - depth);
                    gl.uniform1f(qLoc.uAA, (worldPerPixel * dist2) / Math.max(1e-4, sy));

                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                }
            }

            drawStrings(0, split);
            beginQuads();
            drawQuads(0, split);
            gl.disableVertexAttribArray(qLoc.aCorner);

            drawHalo();

            drawStrings(split, n - split);
            beginQuads();
            drawQuads(split, n);
            gl.disableVertexAttribArray(qLoc.aCorner);
        }
        raf = requestAnimationFrame(frame);

        function destroy() {
            running = false;
            mediaAlive = false;
            cancelAnimationFrame(raf);
            ro.disconnect();
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointerleave", onLeave);
            canvas.removeEventListener("wheel", onWheel);
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", release);
            window.removeEventListener("pointercancel", release);

            gl.deleteBuffer(quadBuf);
            gl.deleteBuffer(ballBuf);
            gl.deleteBuffer(ballTri);
            gl.deleteBuffer(ballEdge);
            gl.deleteBuffer(lineBuf);
            gl.deleteTexture(white);
            media.forEach(function (m) {
                if (m.texture) gl.deleteTexture(m.texture);
                m.texture = null;
            });
            while (graveyard.length) gl.deleteTexture(graveyard.pop());
            gl.deleteProgram(quadProg);
            gl.deleteProgram(solidProg);
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }

        return { destroy: destroy };
    }

    global.createSphereGallery3D = createSphereGallery3D;
})(window);
