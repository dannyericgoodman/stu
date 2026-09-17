// Confetti cannons — little celebration when Danny adds a founder to his pipeline.
// No dependency: a fixed canvas, two cannons (bottom-left / bottom-right),
// ~120 particles with gravity, ~2.4s, then the canvas removes itself.
// 2026-09-17 — Danny asked for confetti cannons on add-to-pipeline.

const COLORS = ['#ff577f', '#ff884b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388eb', '#f8f7ff'];

function makeParticles(originX, originY, count, angleSpread) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const angle = angleSpread[0] + Math.random() * (angleSpread[1] - angleSpread[0]);
    const speed = 9 + Math.random() * 9;
    out.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.3,
      life: 1,
      decay: 0.008 + Math.random() * 0.012,
    });
  }
  return out;
}

export function fireConfettiCannons() {
  try {
    // Don't stack cannons if he mashes the key.
    if (document.querySelector('[data-confetti-cannons]')) return;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-confetti-cannons', '1');
    canvas.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    function resize() {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const W = () => window.innerWidth;
    const H = () => window.innerHeight;

    // Cannons sit just off the bottom corners, aimed up-inward.
    // Angles in radians: -PI/2 is straight up.
    let particles = [
      ...makeParticles(W() * 0.08, H() + 10, 70, [-Math.PI / 2 - 0.45, -Math.PI / 2 + 0.15]),
      ...makeParticles(W() * 0.92, H() + 10, 70, [-Math.PI / 2 - 0.15, -Math.PI / 2 + 0.45]),
    ];

    const gravity = 0.32;
    const drag = 0.992;
    let frames = 0;
    let raf = 0;

    function tick() {
      frames++;
      ctx.clearRect(0, 0, W(), H());

      particles = particles.filter((p) => p.life > 0 && p.y < H() + 40);
      for (const p of particles) {
        p.vy += gravity;
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        p.life -= p.decay;

        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.6));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      // Keep firing small bursts for the first ~20 frames so it reads as cannons,
      // not a single pop.
      if (frames < 22 && frames % 6 === 0) {
        particles.push(
          ...makeParticles(W() * 0.08, H() + 10, 12, [-Math.PI / 2 - 0.4, -Math.PI / 2 + 0.1]),
          ...makeParticles(W() * 0.92, H() + 10, 12, [-Math.PI / 2 - 0.1, -Math.PI / 2 + 0.4])
        );
      }

      if (frames < 160 && particles.length) {
        raf = requestAnimationFrame(tick);
      } else {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        canvas.remove();
      }
    }

    raf = requestAnimationFrame(tick);
  } catch {
    // Celebration is never load-bearing. If canvas fails, the add still worked.
  }
}
