/* ============================================================
   Aether Field — particle-system.js
   ------------------------------------------------------------
   Particles are passive TRACERS of the fluid. They do not move on
   their own random forces; each frame they sample the fluid velocity
   at their position and follow it (with slight inertial lag):

       u = fluid.sampleVelocity(particle.x, particle.y)   // bilinear
       particle.vx = lerp(particle.vx, u.x, fluidFollowStrength)
       particle.vy = lerp(particle.vy, u.y, fluidFollowStrength)
       particle.x += particle.vx · dt
       particle.y += particle.vy · dt

   Color comes from the fluid's local "temperature":

       T = clamp(a·|u| + b·|ω| + c·treble + d·flux + e·centroid, 0, 1)

   mapped through color-mapper.js. Depth and the dye field modulate
   brightness/size (not hue), giving plasma-like glow and parallax.

   Rendering uses pre-baked radial glow sprites drawn with the
   "lighter" (additive) blend mode — cheaper than per-particle
   shadowBlur while still producing soft bloom.
   ============================================================ */

(function (Aether) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  class ParticleSystem {
    constructor(colorMapper) {
      this.color = colorMapper;
      this.particles = [];
      this.scratch = { x: 0, y: 0 }; // reused sample target (no per-particle alloc)

      this.config = {
        spriteSize: 64,        // glow sprite resolution (px)
        spriteCount: 40,       // pre-baked temperature steps
        fluidFollowBase: 0.18, // lerp factor at 60fps (inertial lag)
        brightness: 1.0,       // particle brightness multiplier (set by app)
        velRef: 520,           // px/s that maps to "hot" velocity (set by app)
        vortRef: 7,            // curl magnitude that maps to "hot" vorticity (set by app)
        // Temperature coefficients (must match README §12). Velocity (a) and
        // vorticity (b) vary across the field; the audio terms (c,d,e) are the
        // same everywhere, so they're kept small to avoid washing the whole
        // field one uniform hot color when the music is loud.
        coeff: { a: 0.5, b: 0.25, c: 0.32, d: 0.2, e: 0.2 },
      };

      this._buildSprites();
    }

    /* Pre-bake one soft radial glow sprite per temperature step. */
    _buildSprites() {
      this.sprites = [];
      const size = this.config.spriteSize;
      const r = size / 2;
      for (let s = 0; s < this.config.spriteCount; s++) {
        const t = s / (this.config.spriteCount - 1);
        const [cr, cg, cb] = this.color.colorAt(t);
        const off = document.createElement("canvas");
        off.width = off.height = size;
        const c = off.getContext("2d");
        const g = c.createRadialGradient(r, r, 0, r, r, r);
        g.addColorStop(0.0, `rgba(${cr},${cg},${cb},1)`);
        g.addColorStop(0.25, `rgba(${cr},${cg},${cb},0.55)`);
        g.addColorStop(0.55, `rgba(${cr},${cg},${cb},0.16)`);
        g.addColorStop(1.0, `rgba(${cr},${cg},${cb},0)`);
        c.fillStyle = g;
        c.fillRect(0, 0, size, size);
        this.sprites.push(off);
      }
    }

    _makeParticle(w, h, p) {
      p = p || {};
      p.x = Math.random() * w;
      p.y = Math.random() * h;
      // Depth 0 (far) .. 1 (near): drives size, brightness, follow strength.
      p.z = Math.pow(Math.random(), 1.5);
      p.vx = 0;
      p.vy = 0;
      p.speed = 0;
      p.phase = Math.random() * Math.PI * 2;
      p.life = 6 + Math.random() * 10; // seconds before recycling (keeps field fresh)
      p.maxLife = p.life;              // for the spawn/death alpha fade
      return p;
    }

    // Build / resize the particle pool to `count`.
    rebuild(count, w, h) {
      const arr = new Array(count);
      for (let i = 0; i < count; i++) arr[i] = this._makeParticle(w, h);
      this.particles = arr;
      this.viewW = w;
      this.viewH = h;
    }

    setView(w, h) { this.viewW = w; this.viewH = h; }

    /* ---------------------------------------------------------
       Advect every particle through the fluid velocity field.
       --------------------------------------------------------- */
    update(dt, fluid, audio) {
      const w = this.viewW, h = this.viewH;
      const cfg = this.config;
      // Frame-rate-aware inertial follow factor.
      const ps = this.particles;
      const out = this.scratch;
      const margin = 30;
      const core = fluid.core && fluid.core.r > 0 ? fluid.core : null;

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        fluid.sampleVelocity(p.x, p.y, out);

        // Near particles follow the flow a touch more eagerly than far ones.
        const followBase = cfg.fluidFollowBase * (0.7 + p.z * 0.5);
        const follow = 1 - Math.pow(1 - clamp(followBase, 0, 0.95), dt * 60);

        p.vx += (out.x - p.vx) * follow;
        p.vy += (out.y - p.vy) * follow;

        // Black-hole gravity: the projection step removes most of a pure
        // sink from the (incompressible) velocity field, so tracers get a
        // small direct pull instead — they spiral inward on the accretion
        // current and are consumed at the event horizon.
        if (core) {
          const cdx = core.x - p.x, cdy = core.y - p.y;
          const cd = Math.hypot(cdx, cdy) || 1e-4;
          if (cd < core.r * 0.95) {
            this._respawnOutsideCore(p, w, h, core);  // crossed the horizon
            continue;
          }
          const grav = core.pull * Math.pow(core.r / cd, 1.5);
          p.vx += (cdx / cd) * grav * dt;
          p.vy += (cdy / cd) * grav * dt;
        }

        // Tiny treble jitter on near particles -> shimmering sparks.
        if (audio.treble > 0.1) {
          const j = audio.treble * 14 * p.z;
          p.vx += (Math.random() - 0.5) * j;
          p.vy += (Math.random() - 0.5) * j;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.speed = Math.hypot(p.vx, p.vy);

        // Recycle when off-screen or aged out (so the field keeps renewing).
        p.life -= dt;
        if (
          p.life <= 0 ||
          p.x < -margin || p.x > w + margin ||
          p.y < -margin || p.y > h + margin
        ) {
          this._makeParticle(w, h, p);
        }
      }
    }

    // Respawn a particle consumed by the black hole, never inside it.
    _respawnOutsideCore(p, w, h, core) {
      this._makeParticle(w, h, p);
      for (let tries = 0; tries < 8; tries++) {
        const dx = p.x - core.x, dy = p.y - core.y;
        if (dx * dx + dy * dy > core.r * core.r * 2.25) break; // > 1.5 r away
        p.x = Math.random() * w;
        p.y = Math.random() * h;
      }
    }

    /* ---------------------------------------------------------
       Draw every particle. Caller sets globalCompositeOperation
       to "lighter" before calling (additive bloom).
       --------------------------------------------------------- */
    draw(ctx, fluid, audio, time, intensity) {
      const cfg = this.config;
      const co = cfg.coeff;
      const ps = this.particles;
      const sprites = this.sprites;
      const nSprite = sprites.length;

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];

        // Local fluid properties at this particle.
        const velN = clamp(p.speed / cfg.velRef, 0, 1);
        const vortN = clamp(Math.abs(fluid.sampleVorticity(p.x, p.y)) / cfg.vortRef, 0, 1);
        const dye = fluid.sampleDye(p.x, p.y);

        // Temperature -> hue (color must not flicker randomly).
        const T = this.color.temperature(velN, vortN, audio.treble, audio.flux, audio.centroid, co);
        const idx = Math.min(nSprite - 1, (T * (nSprite - 1)) | 0);
        const sprite = sprites[idx];

        const flicker = 0.85 + Math.sin(time * 6 + p.phase) * 0.15 * (0.3 + audio.treble);
        const size =
          (1.0 + p.z * 2.0 + velN * 2.4 + audio.bass * 3 * p.z * intensity) *
          (2.2 + p.z * 1.7) * flicker;
        // No global loudness term here: a uniform "everything brighter when
        // loud" factor is exactly what stacked (additively) into a white mess.
        // Brightness varies per particle (depth + local speed + dye) and is
        // hard-capped so overlapping cores can't blow out to pure white.
        // Ease in over the first ~0.6s and out over the last ~0.8s of life so
        // recycled particles never pop into / out of existence in one frame.
        const age = p.maxLife - p.life;
        const lifeFade = clamp(Math.min(age * 1.6, p.life * 1.2), 0, 1);
        const alpha = clamp(
          (0.07 + p.z * 0.26 + velN * 0.16 + dye * 0.10) * flicker * cfg.brightness,
          0, 0.85
        ) * lifeFade;

        const half = size / 2;
        ctx.globalAlpha = alpha;
        ctx.drawImage(sprite, p.x - half, p.y - half, size, size);
      }
      ctx.globalAlpha = 1;
    }
  }

  Aether.ParticleSystem = ParticleSystem;
})((window.Aether = window.Aether || {}));
