(() => {
  const canvas = document.getElementById("globe");
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const center = size / 2;
  const radius = size * 0.4;

  const starCanvas = document.getElementById("starfield");
  const starCtx = starCanvas.getContext("2d");
  let stars = [];

  function resizeStars() {
    starCanvas.width = window.innerWidth;
    starCanvas.height = window.innerHeight;
    stars = Array.from({ length: 140 }, () => ({
      x: Math.random() * starCanvas.width,
      y: Math.random() * starCanvas.height,
      r: Math.random() * 1.4 + 0.2,
      tw: Math.random() * Math.PI * 2,
      sp: 0.008 + Math.random() * 0.02
    }));
  }
  resizeStars();
  window.addEventListener("resize", resizeStars);

  const dots = [];
  const DOT_ROWS = 44;
  for (let i = 0; i < DOT_ROWS; i += 1) {
    const lat = (i / (DOT_ROWS - 1)) * Math.PI - Math.PI / 2;
    const rowCount = Math.max(5, Math.round(Math.cos(lat) * 62));
    for (let j = 0; j < rowCount; j += 1) {
      const lon = (j / rowCount) * Math.PI * 2;
      dots.push({ lat, lon, bright: Math.random() });
    }
  }

  const arcs = [];
  function spawnArc() {
    const a = dots[Math.floor(Math.random() * dots.length)];
    const b = dots[Math.floor(Math.random() * dots.length)];
    arcs.push({ a, b, t: 0, speed: 0.008 + Math.random() * 0.012 });
    if (arcs.length > 7) arcs.shift();
  }
  setInterval(spawnArc, 900);

  let rotation = 0;
  let speed = 0.0035;
  let mood = "idle";

  function project(lat, lon, rot) {
    const x3 = Math.cos(lat) * Math.sin(lon + rot);
    const y3 = Math.sin(lat);
    const z3 = Math.cos(lat) * Math.cos(lon + rot);
    return {
      x: center + x3 * radius,
      y: center - y3 * radius * 0.96,
      z: z3
    };
  }

  function themeColor(name, fallback) {
    return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
  }

  function draw(now) {
    const accent = themeColor("--accent", "#00ff8c");
    const danger = themeColor("--danger", "#ff2e4d");
    const main = mood === "listening" ? danger : accent;

    starCtx.clearRect(0, 0, starCanvas.width, starCanvas.height);
    for (const s of stars) {
      s.tw += s.sp;
      starCtx.globalAlpha = 0.25 + Math.abs(Math.sin(s.tw)) * 0.5;
      starCtx.fillStyle = main;
      starCtx.fillRect(s.x, s.y, s.r, s.r);
    }
    starCtx.globalAlpha = 1;

    ctx.clearRect(0, 0, size, size);

    const targetSpeed = mood === "thinking" ? 0.016 : mood === "listening" ? 0.009 : 0.0035;
    speed += (targetSpeed - speed) * 0.04;
    rotation += speed;

    const wobble = Math.sin(now / 1600) * 0.05;

    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(wobble * 0.4);
    ctx.translate(-center, -center);

    for (const dot of dots) {
      const p = project(dot.lat, dot.lon, rotation);
      if (p.z < -0.15) continue;
      const depth = (p.z + 1) / 2;
      const flicker = 0.6 + 0.4 * Math.sin(now / 700 + dot.bright * 20);
      ctx.globalAlpha = Math.max(0.06, depth * 0.85 * flicker);
      ctx.fillStyle = main;
      const dotSize = 1.6 + depth * 2.2;
      ctx.fillRect(p.x - dotSize / 2, p.y - dotSize / 2, dotSize, dotSize);
    }
    ctx.globalAlpha = 1;

    for (let i = arcs.length - 1; i >= 0; i -= 1) {
      const arc = arcs[i];
      arc.t += arc.speed * (mood === "thinking" ? 2.2 : 1);
      if (arc.t >= 1) { arcs.splice(i, 1); continue; }
      const pa = project(arc.a.lat, arc.a.lon, rotation);
      const pb = project(arc.b.lat, arc.b.lon, rotation);
      if (pa.z < 0 && pb.z < 0) continue;
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2 - radius * 0.25;
      const head = arc.t;
      const tail = Math.max(0, arc.t - 0.25);
      ctx.strokeStyle = main;
      ctx.lineWidth = 1.8;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let t = tail; t <= head; t += 0.02) {
        const x = (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * mx + t * t * pb.x;
        const y = (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * my + t * t * pb.y;
        if (t === tail) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (let ring = 0; ring < 3; ring += 1) {
      const ringPhase = now / (2600 + ring * 900) + ring * 2;
      const ringRadius = radius * (1.06 + ring * 0.08);
      ctx.strokeStyle = main;
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(center, center, ringRadius, ringRadius * (0.32 - ring * 0.04), wobble + ring * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      const sx = center + Math.cos(ringPhase) * ringRadius;
      const sy = center + Math.sin(ringPhase) * ringRadius * (0.32 - ring * 0.04);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = main;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (mood === "thinking") {
      const pulse = (now / 500) % 1;
      ctx.strokeStyle = main;
      ctx.globalAlpha = (1 - pulse) * 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(center, center, radius * (1 + pulse * 0.22), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);

  window.ZenoGlobe = {
    setMood(next) {
      mood = next;
      document.body.classList.toggle("thinking", next === "thinking");
      document.body.classList.toggle("listening", next === "listening");
      const state = document.getElementById("globe-state");
      state.textContent = next === "thinking" ? "PROCESSING" : next === "listening" ? "LISTENING" : "";
    },
    onClick(handler) {
      canvas.addEventListener("click", handler);
    }
  };
})();
