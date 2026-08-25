/* تأثيرات الموقع — خلفية شبكة تفاعلية + مؤشر محاور X/Y (مستوحاة من Originkit) */
(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canPointer = window.matchMedia('(pointer: fine)').matches;
  if (reduceMotion || !canPointer) return;
  document.documentElement.classList.add('fx-ready');

  var vLine = document.createElement('div');
  var hLine = document.createElement('div');
  var label = document.createElement('div');
  vLine.id = 'axis-v'; hLine.id = 'axis-h'; label.id = 'axis-label';
  document.body.append(vLine, hLine, label);

  var canvas = document.createElement('canvas');
  canvas.id = 'kinetic-bg';
  document.body.prepend(canvas);
  var ctx = canvas.getContext('2d');
  var W, H, dots = [];
  var spacing = 46, radius = 150, strength = 26;
  var mouse = { x: -9999, y: -9999 };

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    dots = [];
    for (var x = spacing / 2; x < W + spacing; x += spacing) {
      for (var y = spacing / 2; y < H + spacing; y += spacing) {
        dots.push({ ox: x, oy: y, x: x, y: y });
      }
    }
  }
  window.addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', function (e) {
    mouse.x = e.clientX; mouse.y = e.clientY;
    vLine.style.transform = 'translateX(' + e.clientX + 'px)';
    hLine.style.transform = 'translateY(' + e.clientY + 'px)';
    label.style.transform = 'translate(' + (e.clientX + 16) + 'px,' + (e.clientY + 14) + 'px)';
    label.textContent = 'X:' + e.clientX + '  Y:' + e.clientY;
    label.classList.add('show');
  });
  document.addEventListener('mouseleave', function () {
    mouse.x = -9999; mouse.y = -9999;
    label.classList.remove('show');
  });

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < dots.length; i++) {
      var d = dots[i];
      var dx = mouse.x - d.ox, dy = mouse.y - d.oy;
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
        ctx.lineTo(mouse.x, mouse.y);
        ctx.strokeStyle = 'rgba(76,95,213,' + (0.14 * (1 - dist / radius)) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
})();
