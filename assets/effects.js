/* تأثيرات الموقع — خلفية شبكة تفاعلية (Kinetic Grid) + أثر الفأرة (Ribbon Trails) من Originkit */
(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canPointer = window.matchMedia('(pointer: fine)').matches;
  if (reduceMotion || !canPointer) return;
  document.documentElement.classList.add('fx-ready');

  /* ---------- الخلفية: Kinetic Grid ---------- */
  var canvas = document.createElement('canvas');
  canvas.id = 'kinetic-bg';
  document.body.prepend(canvas);
  var ctx = canvas.getContext('2d');
  var W, H, dots = [];
  var spacing = 46, radius = 150, strength = 26;
  var bgMouse = { x: -9999, y: -9999 };

  function resizeBg() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    dots = [];
    for (var x = spacing / 2; x < W + spacing; x += spacing) {
      for (var y = spacing / 2; y < H + spacing; y += spacing) {
        dots.push({ ox: x, oy: y, x: x, y: y });
      }
    }
  }
  window.addEventListener('resize', resizeBg);
  resizeBg();

  window.addEventListener('mousemove', function (e) {
    bgMouse.x = e.clientX; bgMouse.y = e.clientY;
  });
  document.addEventListener('mouseleave', function () {
    bgMouse.x = -9999; bgMouse.y = -9999;
  });

  function tickBg() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var dx = bgMouse.x - d.ox, dy = bgMouse.y - d.oy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var tx = d.ox, ty = d.oy;
      if (dist < radius && dist > 0.01) {
        var force = (1 - dist / radius) * strength;
        tx = d.ox - (dx / dist) * force;
        ty = d.oy - (dy / dist) * force;
      }
      d.x += (tx - d.x) * 0.12;
      d.y += (ty - d.y) * 0.12;
      ctx.beginPath();
      ctx.arc(d.x, d.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(76,95,213,.4)';
      ctx.fill();
      if (dist < radius) {
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(bgMouse.x, bgMouse.y);
        ctx.strokeStyle = 'rgba(76,95,213,' + (0.14 * (1 - dist / radius)) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    requestAnimationFrame(tickBg);
  }
  tickBg();

  /* ---------- أثر الفأرة: Originkit "Ribbon Trails" ----------
     منقول حرفيًا من مكوّن Originkit (ui/ribbon-trails.tsx) — نفس الثوابت
     ونفس فيزياء الحركة (Line/TrailNode) ونفس تحويل الألوان عبر OKLab،
     وتم فقط استبدال غلاف React (useEffect/JSX) بإعداد canvas عادي
     يغطي الصفحة كلها، مع ألوان الموقع (ذهبي/مرجاني/نعناعي/نيلي)
     بدل الألوان الافتراضية، وبدون نص "HOVER ME" التجريبي. */
  (function ribbonTrails() {
    var DEFAULTS = {
      colors: ['#ffc93c', '#ff6b4a', '#22b573', '#4c5fd5'],
      colorShift: 1,
      opacity: 55,
      thickness: 2,
      trails: 40,
      trailLength: 24
    };
    var MAX_COLORS = 5;
    var DAMPENING = 0.1;
    var TENSION = 0.95;
    var FRICTION = 0.5;
    var REFERENCE_TRAILS = 20;
    var MAX_STROKE_L = 0.7;

    function TrailNode() {
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    }

    function Line(cfg) {
      this.cfg = cfg;
      this.spring = cfg.spring + 0.1 * Math.random() - 0.02;
      this.friction = cfg.friction + 0.01 * Math.random() - 0.002;
      this.nodes = [];
      for (var i = 0; i < cfg.size; i++) {
        var node = new TrailNode();
        node.x = cfg.target.x;
        node.y = cfg.target.y;
        this.nodes.push(node);
      }
    }
    Line.prototype.update = function () {
      var spring = this.spring;
      var target = this.cfg.target, dampening = this.cfg.dampening, tension = this.cfg.tension;
      var node = this.nodes[0];

      node.vx += (target.x - node.x) * spring;
      node.vy += (target.y - node.y) * spring;

      for (var i = 0, len = this.nodes.length; i < len; i++) {
        node = this.nodes[i];
        if (i > 0) {
          var prev = this.nodes[i - 1];
          node.vx += (prev.x - node.x) * spring;
          node.vy += (prev.y - node.y) * spring;
          node.vx += prev.vx * dampening;
          node.vy += prev.vy * dampening;
        }
        node.vx *= this.friction;
        node.vy *= this.friction;
        node.x += node.vx;
        node.y += node.vy;
        spring *= tension;
      }
    };
    Line.prototype.draw = function (ctx) {
      var a, b;
      var x = this.nodes[0].x;
      var y = this.nodes[0].y;

      ctx.beginPath();
      ctx.moveTo(x, y);

      for (var i = 1, len = this.nodes.length - 2; i < len; i++) {
        a = this.nodes[i];
        b = this.nodes[i + 1];
        x = 0.5 * (a.x + b.x);
        y = 0.5 * (a.y + b.y);
        ctx.quadraticCurveTo(a.x, a.y, x, y);
      }

      a = this.nodes[this.nodes.length - 2];
      b = this.nodes[this.nodes.length - 1];
      ctx.quadraticCurveTo(a.x, a.y, b.x, b.y);
      ctx.stroke();
      ctx.closePath();
    };

    function parseColor(color) {
      var value = (color || '').trim();

      if (value.charAt(0) === '#') {
        var hex = value.slice(1);
        if (hex.length === 3) {
          hex = hex.split('').map(function (c) { return c + c; }).join('');
        }
        if (hex.length >= 6) {
          return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
          ];
        }
        return [1, 1, 1, 1];
      }

      var m = value.match(/rgba?\(([^)]+)\)/i);
      if (m) {
        var p = m[1].split(',').map(function (s) { return parseFloat(s); });
        return [
          (p[0] || 0) / 255,
          (p[1] || 0) / 255,
          (p[2] || 0) / 255,
          p[3] === undefined ? 1 : p[3]
        ];
      }
      return [1, 1, 1, 1];
    }

    function toLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function toGamma(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

    function srgbToOklab(r, g, b) {
      var lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
      var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
      var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
      var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
      return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
      ];
    }

    function oklabToSrgb(L, A, B) {
      var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
      var m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
      var s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
      return [
        toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
      ];
    }

    function inGamut(rgb) {
      return rgb.every(function (c) { return c >= -0.001 && c <= 1.001; });
    }

    function strokeFor(color, maxL, alpha) {
      var c0 = parseColor(color);
      var r = c0[0], g = c0[1], b = c0[2];
      var lab = srgbToOklab(r, g, b);
      var L = lab[0], A = lab[1], B = lab[2];
      if (L <= maxL) {
        var rgb0 = [r, g, b].map(function (c) { return Math.round(c * 255); });
        return 'rgba(' + rgb0[0] + ', ' + rgb0[1] + ', ' + rgb0[2] + ', ' + alpha + ')';
      }

      var C = Math.hypot(A, B);
      var hue = Math.atan2(B, A);
      var cos = Math.cos(hue);
      var sin = Math.sin(hue);

      var fitted = C;
      if (!inGamut(oklabToSrgb(maxL, cos * C, sin * C))) {
        var lo = 0, hi = C;
        for (var i = 0; i < 16; i++) {
          var mid = (lo + hi) / 2;
          if (inGamut(oklabToSrgb(maxL, cos * mid, sin * mid))) lo = mid;
          else hi = mid;
        }
        fitted = lo;
      }

      var rgb = oklabToSrgb(maxL, cos * fitted, sin * fitted).map(function (c) {
        return Math.round(Math.min(1, Math.max(0, c)) * 255);
      });
      return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + alpha + ')';
    }

    var colors = DEFAULTS.colors, colorShift = DEFAULTS.colorShift, opacity = DEFAULTS.opacity,
      thickness = DEFAULTS.thickness, trails = DEFAULTS.trails, trailLength = DEFAULTS.trailLength;

    var rCanvas = document.createElement('canvas');
    rCanvas.id = 'ribbon-trails';
    document.body.appendChild(rCanvas);
    var rCtx = rCanvas.getContext('2d');

    var count = Math.max(1, Math.round(trails));
    var picked = (colors || []).filter(Boolean).slice(0, MAX_COLORS);
    var palette = picked.length ? picked : DEFAULTS.colors;

    var weight = Math.min(100, Math.max(0, opacity)) / 100;
    var fade = Math.min(1, REFERENCE_TRAILS / count);
    var strokes = palette.map(function (entry) {
      return strokeFor(entry, MAX_STROKE_L, weight * parseColor(entry)[3] * fade);
    });

    var running = true;
    var rafId = 0;
    var started = false;
    var target = { x: 0, y: 0 };
    var bornAt = 0;
    var holdMs = Math.max(0.1, colorShift) * 1000;

    var lineCfg = {
      spring: 0.4,
      friction: FRICTION,
      dampening: DAMPENING,
      tension: TENSION,
      size: Math.max(2, Math.round(trailLength)),
      target: target
    };
    var lines = [];

    function buildLines() {
      lines = [];
      for (var i = 0; i < count; i++) {
        lines.push(new Line({
          spring: 0.4 + (i / count) * 0.025,
          friction: lineCfg.friction,
          dampening: lineCfg.dampening,
          tension: lineCfg.tension,
          size: lineCfg.size,
          target: lineCfg.target
        }));
      }
    }

    function resizeRibbon() {
      rCanvas.width = Math.max(1, Math.round(window.innerWidth));
      rCanvas.height = Math.max(1, Math.round(window.innerHeight));
    }

    function updatePosition(e) {
      var clientX, clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      target.x = clientX;
      target.y = clientY;
    }

    function onFirstMove(e) {
      moveTarget.removeEventListener('mousemove', onFirstMove);
      moveTarget.removeEventListener('touchstart', onFirstMove);
      moveTarget.addEventListener('mousemove', updatePosition);
      moveTarget.addEventListener('touchmove', updatePosition, { passive: true });
      updatePosition(e);
      buildLines();
      started = true;
      loop();
    }

    function loop() {
      if (!running || !rCtx || !rCanvas) return;
      rCtx.globalCompositeOperation = 'source-over';
      rCtx.clearRect(0, 0, rCanvas.width, rCanvas.height);
      rCtx.globalCompositeOperation = 'lighter';
      if (bornAt === 0) bornAt = performance.now();
      var held = Math.floor((performance.now() - bornAt) / holdMs);
      rCtx.strokeStyle = strokes[held % strokes.length];
      rCtx.lineWidth = Math.max(0.1, thickness);

      for (var i = 0; i < count; i++) {
        var line = lines[i];
        if (!line) continue;
        line.update();
        line.draw(rCtx);
      }
      rafId = window.requestAnimationFrame(loop);
    }

    function handleFocus() {
      if (!running) {
        running = true;
        if (started) loop();
      }
    }
    function handleBlur() {
      running = false;
    }

    var moveTarget = document;
    moveTarget.addEventListener('mousemove', onFirstMove);
    moveTarget.addEventListener('touchstart', onFirstMove, { passive: true });

    window.addEventListener('resize', resizeRibbon);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    resizeRibbon();
  })();
})();
