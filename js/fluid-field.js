/* ============================================================
   Aether Field — fluid-field.js
   ------------------------------------------------------------
   A 2D, approximately incompressible fluid solver based on
   Jos Stam's "Stable Fluids" (SIGGRAPH 1999). Particles are
   advected as passive tracers through the resulting velocity
   field — they do NOT move from independent random forces.

   Governing equations (incompressible Navier–Stokes):

       ∂u/∂t + (u · ∇)u = -∇p/ρ + ν∇²u + f      (momentum)
       ∇ · u = 0                                 (incompressibility)

   where
       u  velocity field            p  pressure
       ρ  density (folded into p)    ν  viscosity
       f  external force (audio + pointer + procedural turbulence)

   Per-step pipeline (Stam, slightly reordered per spec):

       1. Add forces        f -> u                (audio, pointer, turbulence, vorticity)
       2. Advect velocity   move u along itself   (semi-Lagrangian back-trace)
       3. Diffuse velocity  ν∇²u                  (Gauss–Seidel relaxation)
       4. Project velocity  remove ∇·u            (Jacobi pressure solve)
       5. Advect particles  (handled in particle-system.js using sampleVelocity)

   The grid is low-resolution for speed; particles render at full
   screen resolution. All buffers are typed Float32Arrays allocated
   once (on construct / resize) and reused — no allocation in step().

   Coordinate convention
   ---------------------
   The grid has a 1-cell boundary ring. Interior indices run
   i ∈ [1, W-2], j ∈ [1, H-2]. A screen pixel (px, py) maps to a
   continuous grid coordinate where an integer index = a cell center:

       gx = px / scale + 0.5        gy = py / scale + 0.5

   Velocities are stored in pixels/second, so particle advection is
   simply  x += u·dt . Advection back-tracing converts to grid units
   by dividing the displacement by `scale`.
   ============================================================ */

(function (Aether) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mix = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  class FluidField {
    /**
     * @param {number} width  viewport width in pixels
     * @param {number} height viewport height in pixels
     * @param {number} scale  pixels per grid cell (cell size)
     */
    constructor(width, height, scale) {
      this.scale = scale;
      this.time = 0;
      this.dt = 1 / 60;

      // Overall force multiplier (driven by the visual-intensity slider).
      this.forceGain = 1;

      // ---- Tunable constants (see README "Customization guide") ----
      this.config = {
        pressureIterations: 22,   // PRESSURE_ITERATIONS (12..28): higher = more incompressible
        diffuseIterations: 4,     // viscosity relaxation sweeps

        // Viscosity is modulated by overall energy:
        //   viscosity = mix(viscHigh, viscLow, energyNorm)
        // calm music -> smoother (higher ν); intense -> sharper (lower ν).
        viscLow: 0.000010,
        viscHigh: 0.000060,

        velocityDissipation: 0.55, // velocity drag per second (field settles when quiet)
        dyeDissipation: 1.1,       // dye fade per second

        // Vorticity confinement strength:
        //   vorticityStrength = baseVorticity + mid*midGain + flux*fluxGain
        vorticity: 0.14,
        midVortGain: 0.55,
        fluxVortGain: 0.85,

        // Procedural ambient turbulence (keeps a calm drift during silence,
        // grows sharp/chaotic with high-mid energy).
        turbBase: 2.2,
        turbHighMidGain: 30,

        // ---- Black-hole core --------------------------------------------
        // A dark ball sits at the center of the field. Its SURFACE is a
        // circular spectrum analyzer: every direction on the rim owns one
        // frequency band (bass at the bottom, treble at the top, mirrored
        // left/right), and that band's actual FFT energy m_b radiates a
        // traveling pressure wave into the liquid from the surface:
        //
        //   w_b(r,t) = A · m_b · sin(k_b·r − ω_b·t) · (1 − r/reach)²
        //
        //   A (master amplitude) = ampBase + rms·ampRms + bass·ampBass + onset·ampOnset
        //   k_b = 2π/λ_b,  λ_b = mix(λLarge, λSmall, band)   (bass swells, treble ripples)
        //   ω_b = (omegaBase + energy·omegaGain)·(0.8 + 0.7·band)  (treble travels faster)
        //
        // The ball also pulls fluid + particles inward like gravity, spins a
        // slow accretion current around itself, and consumes any particle
        // that crosses the event horizon (see particle-system.js).
        coreRadius: 0.105,    // event-horizon radius (× min(w,h))
        coreReach: 0.55,      // how far surface waves radiate (× min(w,h))
        coreAmpBase: 1.2,     // quiet baseline wave amplitude
        coreAmpRms: 18,       // loudness → wave amplitude
        coreAmpBass: 24,      // bass → wave amplitude (the "thump")
        coreAmpOnset: 55,     // beats → amplitude punch
        waveLambdaLarge: 460, // bass end: big slow swells (px)
        waveLambdaSmall: 80,  // treble end: tight fast ripples (px)
        waveOmegaBase: 3.2,   // base wave speed (rad/s)
        waveOmegaGain: 7.0,   // energy → faster waves
        // NOTE: the swirl/pull forces are added EVERY frame and only decay
        // through velocityDissipation, so their equilibrium speed is roughly
        // strength·60/dissipation — keep them small or the whole field goes
        // past velRef and washes out to white.
        corePull: 26,         // inward gravity on the fluid (scaled by energy)
        corePullParticles: 80,// inward drift on particle tracers (px/s² at the rim)
        coreSwirl: 3,         // baseline accretion rotation around the hole
        coreSwirlLowMid: 14,  // low-mid energy → faster accretion spin
        coreDye: 0.35,        // spectrum energy → dye glow at the surface

        // Smooth, non-random global motions
        subBreathGain: 16,   // sub-bass: slow global breathing pressure
        driftTurnRate: 0.11, // how fast the accretion spin eases between speeds

        // Pointer interaction
        pointerDrag: 7,      // force along pointer movement
        pointerSwirl: 130,   // local vortex around the pointer
        pointerBurst: 150,   // radial burst on press
        pointerRadius: 95,   // px

        // Hand-tracking interaction (camera). Runs alongside the audio.
        // The swirl + dye terms are CONSTANT (not motion-dependent), so a hand
        // that is simply held up still keeps the fluid breathing around it.
        handDrag: 6,         // force along finger / palm motion
        handSwirl: 70,       // steady fingertip vortex (idle stir)
        handPalmSwirl: 120,  // broader, steady palm vortex
        handDye: 0.02,       // faint per-frame fingertip dye (a hint at rest)
        handPalmDye: 0.035,  // palm glow per frame
        handBurst: 150,      // pinch → radial burst
        handRadius: 55,      // fingertip footprint (px)
        handPalmRadius: 110, // palm footprint (px)

        // Hand GESTURE animations — big deliberate poses → showy effects.
        // (Sized to the detected hand; strength is floored so they pop even
        // when the visual-intensity slider is low — see injectHandForces.)
        gestureOpenPush: 240,    // ✋ open palm → outward shockwave / aura
        gestureOpenDye: 0.9,     // ✋ bright bloom
        gestureFistPull: 210,    // ✊ fist → inward vacuum (negative burst)
        gestureFistSwirl: 320,   // ✊ tight gather-swirl that knots the inflow
        gestureFistDye: 0.5,
        gesturePinchBurst: 340,  // 🤏 pinch → sharp localized spark
        gesturePinchDye: 1.6,
        gestureBridgeSwirl: 170, // ✋✋ two open palms → turbulent energy bridge

        // Flare animation (deliberately kept dim & moderate).
        mergeSwirl: 95,      // rotation of the flare's colored "flower"
        mergePulse: 42,      // gentle radial pulses of the arms
        mergeDye: 0.28,      // colored dye injected at full flare
        mergeArms: 5,        // number of spiral arms
      };

      // ---- Flare animation state (see updateBond) ----
      // Every few minutes the black hole flares: a colored multi-arm bloom
      // builds for `approach` seconds, burns for exactly `merged` seconds,
      // then fades over `separate` seconds. `_mergeFactor` / `flareFactor`
      // (0 = calm, 1 = full flare) and `_bondSpin` (accumulated rotation)
      // drive the bloom in injectAudioForces.
      this.bond = {
        enabled: true,
        active: false,
        elapsed: 0,
        approach: 8,   // seconds building up
        merged: 7,     // seconds at full flare (exactly 7s as requested)
        separate: 8,   // seconds fading back out
        turns: 3,      // full revolutions over the whole animation
        minGap: 300,   // 5 min
        maxGap: 600,   // 10 min
        nextAt: 0,
      };
      this._bondRhoFrac = 1;
      this._bondSpin = 0;
      this._mergeFactor = 0;
      this.flareFactor = 0;
      this._scheduleNextBond();

      // The black-hole core (pixel position/radius, refreshed each step;
      // read by the particle system for gravity + horizon consumption and
      // by the app for rendering the void disc + spectrum rim).
      this.core = { x: width * 0.5, y: height * 0.5, r: 0, pull: 0 };

      this._initGrid(width, height);
    }

    /* ---------------------------------------------------------
       Bonding animation: schedule / trigger / state machine.
       --------------------------------------------------------- */
    _scheduleNextBond() {
      const b = this.bond;
      b.nextAt = this.time + b.minGap + Math.random() * (b.maxGap - b.minGap);
    }

    // Kick off the animation now (manual trigger, e.g. the "B" shortcut).
    triggerBond() {
      if (!this.bond.active) { this.bond.active = true; this.bond.elapsed = 0; }
    }

    setBondEnabled(on) { this.bond.enabled = !!on; }

    _smoother(t) { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }

    updateBond(dt) {
      const b = this.bond;
      if (!b.active) {
        this._bondRhoFrac = 1;   // no flare running
        this._bondSpin = 0;
        this._mergeFactor = 0;
        this.flareFactor = 0;
        if (b.enabled && this.time >= b.nextAt) this.triggerBond();
        return;
      }
      b.elapsed += dt;
      const e = b.elapsed;
      const total = b.approach + b.merged + b.separate;
      let rhoFrac;
      if (e < b.approach) {
        rhoFrac = 1 - this._smoother(e / b.approach);          // build up
      } else if (e < b.approach + b.merged) {
        rhoFrac = 0;                                            // full flare
      } else if (e < total) {
        rhoFrac = this._smoother((e - b.approach - b.merged) / b.separate); // fade out
      } else {
        b.active = false; rhoFrac = 1;
        this._scheduleNextBond();
      }
      this._bondRhoFrac = rhoFrac;
      this._mergeFactor = 1 - rhoFrac;                          // 1 at full flare
      this.flareFactor = this._mergeFactor;
      // One monotonic spin across the whole animation -> ends where it began.
      this._bondSpin = b.turns * TAU * this._smoother(clamp(e / total, 0, 1));
    }

    /* ---------------------------------------------------------
       Allocation (constructor + resize). Never called in step().
       --------------------------------------------------------- */
    _initGrid(width, height) {
      this.pxW = width;
      this.pxH = height;
      // +2 for the boundary ring; clamp to sane minimums.
      this.W = Math.max(8, Math.floor(width / this.scale) + 2);
      this.H = Math.max(8, Math.floor(height / this.scale) + 2);
      const size = this.W * this.H;
      this.size = size;

      this.u = new Float32Array(size);   // velocity x (px/s)
      this.v = new Float32Array(size);   // velocity y (px/s)
      this.u0 = new Float32Array(size);  // previous / scratch velocity x
      this.v0 = new Float32Array(size);  // previous / scratch velocity y
      this.p = new Float32Array(size);   // pressure
      this.div = new Float32Array(size); // divergence
      this.curl = new Float32Array(size);// scalar vorticity ω
      this.dye = new Float32Array(size); // dye / color intensity
      this.dye0 = new Float32Array(size);// dye scratch
    }

    resize(width, height) {
      const W = Math.max(8, Math.floor(width / this.scale) + 2);
      const H = Math.max(8, Math.floor(height / this.scale) + 2);
      this.pxW = width;
      this.pxH = height;
      if (W !== this.W || H !== this.H) this._initGrid(width, height);
    }

    /* ---------------------------------------------------------
       Boundary conditions: closed reflective walls.
       b = 0 scalar (copy), 1 = x-velocity, 2 = y-velocity (negate normal).
       --------------------------------------------------------- */
    _setBnd(b, x) {
      const W = this.W, H = this.H;
      for (let j = 1; j < H - 1; j++) {
        x[0 + j * W] = b === 1 ? -x[1 + j * W] : x[1 + j * W];
        x[W - 1 + j * W] = b === 1 ? -x[W - 2 + j * W] : x[W - 2 + j * W];
      }
      for (let i = 1; i < W - 1; i++) {
        x[i + 0 * W] = b === 2 ? -x[i + 1 * W] : x[i + 1 * W];
        x[i + (H - 1) * W] = b === 2 ? -x[i + (H - 2) * W] : x[i + (H - 2) * W];
      }
      x[0] = 0.5 * (x[1] + x[W]);
      x[(H - 1) * W] = 0.5 * (x[1 + (H - 1) * W] + x[(H - 2) * W]);
      x[W - 1] = 0.5 * (x[W - 2] + x[W - 1 + W]);
      x[W - 1 + (H - 1) * W] = 0.5 * (x[W - 2 + (H - 1) * W] + x[W - 1 + (H - 2) * W]);
    }

    /* ---------------------------------------------------------
       Bilinear sampling of any field at continuous grid coords.
       --------------------------------------------------------- */
    _sampleGrid(field, gx, gy) {
      const W = this.W, H = this.H;
      gx = clamp(gx, 0.5, W - 1.5);
      gy = clamp(gy, 0.5, H - 1.5);
      const i0 = gx | 0, j0 = gy | 0;
      const i1 = i0 + 1, j1 = j0 + 1;
      const s1 = gx - i0, s0 = 1 - s1;
      const t1 = gy - j0, t0 = 1 - t1;
      return (
        s0 * (t0 * field[i0 + j0 * W] + t1 * field[i0 + j1 * W]) +
        s1 * (t0 * field[i1 + j0 * W] + t1 * field[i1 + j1 * W])
      );
    }

    /* =========================================================
       PUBLIC: sampling (used by the particle system)
       ========================================================= */

    // Bilinearly sample fluid velocity at a pixel position.
    // Writes into `out` if provided (avoids per-particle allocation).
    sampleVelocity(px, py, out) {
      out = out || { x: 0, y: 0 };
      const gx = px / this.scale + 0.5;
      const gy = py / this.scale + 0.5;
      out.x = this._sampleGrid(this.u, gx, gy);
      out.y = this._sampleGrid(this.v, gx, gy);
      return out;
    }

    // Bilinearly sample scalar vorticity ω at a pixel position.
    sampleVorticity(px, py) {
      return this._sampleGrid(this.curl, px / this.scale + 0.5, py / this.scale + 0.5);
    }

    // Bilinearly sample dye intensity at a pixel position.
    sampleDye(px, py) {
      return this._sampleGrid(this.dye, px / this.scale + 0.5, py / this.scale + 0.5);
    }

    /* =========================================================
       PUBLIC: force / dye injection primitives
       ========================================================= */

    // Add a velocity impulse (px/s) inside a perfectly circular footprint.
    // The radial falloff (1 - (d/r)²)² is 1 at the center and exactly 0 at the
    // edge, so the affected region is a clean disc — no square box corners.
    addForce(px, py, fx, fy, radiusPx) {
      const W = this.W, H = this.H, scale = this.scale;
      const gx = px / scale + 0.5, gy = py / scale + 0.5;
      const r = Math.max(1, radiusPx / scale);
      const r2 = r * r;
      const i0 = clamp((gx - r) | 0, 1, W - 2);
      const i1 = clamp(Math.ceil(gx + r), 1, W - 2);
      const j0 = clamp((gy - r) | 0, 1, H - 2);
      const j1 = clamp(Math.ceil(gy + r), 1, H - 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - gx, dy = j - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;           // circular cutoff
          const fall = 1 - d2 / r2;
          const w = fall * fall;
          const idx = i + j * W;
          this.u[idx] += fx * w;
          this.v[idx] += fy * w;
        }
      }
    }

    // Add dye/color intensity inside a perfectly circular footprint.
    // (A square box here is what made the speaker blooms look "squary":
    // the faint box corners accumulate over time.)
    addDye(px, py, amount, radiusPx) {
      const W = this.W, H = this.H, scale = this.scale;
      const gx = px / scale + 0.5, gy = py / scale + 0.5;
      const r = Math.max(1, radiusPx / scale);
      const r2 = r * r;
      const i0 = clamp((gx - r) | 0, 1, W - 2);
      const i1 = clamp(Math.ceil(gx + r), 1, W - 2);
      const j0 = clamp((gy - r) | 0, 1, H - 2);
      const j1 = clamp(Math.ceil(gy + r), 1, H - 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - gx, dy = j - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;           // circular cutoff
          const fall = 1 - d2 / r2;
          const idx = i + j * W;
          this.dye[idx] = Math.min(3, this.dye[idx] + amount * fall * fall);
        }
      }
    }

    // Radial push/pull (positive = outward) — used for pressure waves.
    _radialBurst(px, py, strength, radiusPx) {
      const W = this.W, H = this.H, scale = this.scale;
      const gx = px / scale + 0.5, gy = py / scale + 0.5;
      const r = Math.max(1, radiusPx / scale);
      const r2 = r * r;
      const i0 = clamp((gx - r) | 0, 1, W - 2);
      const i1 = clamp(Math.ceil(gx + r), 1, W - 2);
      const j0 = clamp((gy - r) | 0, 1, H - 2);
      const j1 = clamp(Math.ceil(gy + r), 1, H - 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - gx, dy = j - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;           // circular cutoff
          const d = Math.sqrt(d2) || 1e-4;
          const fall = 1 - d2 / r2;
          const w = fall * fall * strength;
          const idx = i + j * W;
          this.u[idx] += (dx / d) * w;
          this.v[idx] += (dy / d) * w;
        }
      }
    }

    // Tangential swirl (positive = counter-clockwise) — vortex emitter.
    _swirl(px, py, strength, radiusPx) {
      const W = this.W, H = this.H, scale = this.scale;
      const gx = px / scale + 0.5, gy = py / scale + 0.5;
      const r = Math.max(1, radiusPx / scale);
      const r2 = r * r;
      const i0 = clamp((gx - r) | 0, 1, W - 2);
      const i1 = clamp(Math.ceil(gx + r), 1, W - 2);
      const j0 = clamp((gy - r) | 0, 1, H - 2);
      const j1 = clamp(Math.ceil(gy + r), 1, H - 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = i - gx, dy = j - gy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;           // circular cutoff
          const d = Math.sqrt(d2) || 1e-4;
          const fall = 1 - d2 / r2;
          const w = fall * fall * strength;
          const idx = i + j * W;
          // tangent = (-dy, dx) / d
          this.u[idx] += (-dy / d) * w;
          this.v[idx] += (dx / d) * w;
        }
      }
    }

    /* =========================================================
       BLACK-HOLE SPECTRUM SURFACE
       The core's surface is a circular spectrum analyzer. Each cell in
       the annulus around the event horizon belongs to the frequency
       band at its angle (bass at the bottom, treble at the top,
       mirrored left/right so there is no seam), and that band's actual
       FFT energy m_b radiates a traveling pressure wave outward from
       the surface:

         w_b(r,t) = A · m_b · sin(k_b·r − ω_b·t) · (1 − r/reach)²

       r is the distance FROM THE SURFACE (not the center), so the rings
       are born at the rim of the ball. Per-band wavelength and speed
       make the spectrum literally visible in the liquid: bass bands
       shed big slow swells, treble bands tight fast ripples. The wave
       is a radial body force, so projection turns it into genuine
       outward-propagating rings. Cells near the surface also receive
       dye ∝ m_b, painting a glowing aura where the music is hot.
       ========================================================= */
    _emitCoreSpectrum(cx, cy, r0, reach, amp, omega, spec, f) {
      const W = this.W, H = this.H, scale = this.scale, u = this.u, v = this.v, dye = this.dye;
      const C = this.config, t = this.time;
      const N = spec.length;
      const gx = cx / scale + 0.5, gy = cy / scale + 0.5;
      const g0 = r0 / scale;                       // horizon radius, grid units
      const g1 = (r0 + reach) / scale;             // outer edge of the annulus
      const g1sq = g1 * g1;
      const gIn = Math.max(0.5, g0 - 1);           // start just inside the rim
      const dyeBand = Math.max(2, (reach * 0.1) / scale);
      const dyeAmt = C.coreDye * f;
      const lamL = C.waveLambdaLarge, lamS = C.waveLambdaSmall;
      const i0 = clamp((gx - g1) | 0, 1, W - 2);
      const i1 = clamp(Math.ceil(gx + g1), 1, W - 2);
      const j0 = clamp((gy - g1) | 0, 1, H - 2);
      const j1 = clamp(Math.ceil(gy + g1), 1, H - 2);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dxg = i - gx, dyg = j - gy;
          const d2 = dxg * dxg + dyg * dyg;
          if (d2 >= g1sq) continue;                // outside the annulus
          const dg = Math.sqrt(d2);
          if (dg < gIn) continue;                  // inside the hole — leave it dead
          // Mirrored band mapping: 0 at the bottom (bass) → 1 at the top
          // (treble); |…| folds left/right onto the same band, so the two
          // halves are symmetric and there is no wrap-around seam.
          const frac = Math.abs(Math.atan2(dxg, dyg)) / Math.PI;
          const bp = frac * (N - 1);
          const b0 = bp | 0;
          const bf = bp - b0;
          const m = spec[b0] + (spec[Math.min(N - 1, b0 + 1)] - spec[b0]) * bf;
          if (m < 0.015) continue;                 // silent band — no wave
          const rpx = (dg - g0) * scale;           // distance from the surface (px)
          const q = clamp(rpx / reach, 0, 1);
          const env = (1 - q) * (1 - q);
          const lam = lamL + (lamS - lamL) * frac; // treble = tight ripples
          const k = TAU / lam;
          const w = Math.sin(k * rpx - omega * (0.8 + 0.7 * frac) * t) * amp * m * env * f;
          const inv = dg > 1e-4 ? 1 / dg : 0;
          const idx = i + j * W;
          u[idx] += dxg * inv * w;
          v[idx] += dyg * inv * w;
          // Glowing aura right at the surface, bright where the band is hot.
          const surf = dg - g0;
          if (surf < dyeBand && surf > -1) {
            dye[idx] = Math.min(3, dye[idx] + dyeAmt * m * (1 - surf / dyeBand));
          }
        }
      }
    }

    /* =========================================================
       FLARE BLOOM — the colored swirl while the black hole flares.
       A small set of spiral arms rotate around the core with
       alternating spin; the varied velocity/vorticity across the
       arms spans the color palette, giving a rotating multi-colored
       flower. Kept deliberately dim (gains scale with flare factor m).
       ========================================================= */
    _emitMergeBloom(cx, cy, sep, R, m) {
      const C = this.config;
      const spin = this._bondSpin;
      const arms = C.mergeArms;
      const armR = sep * (0.10 + 0.30 * (1 - m)); // arms pull inward as they merge
      for (let a = 0; a < arms; a++) {
        const ang = spin * 1.6 + a * (TAU / arms);
        const px = cx + Math.cos(ang) * armR;
        const py = cy + Math.sin(ang) * armR;
        this._swirl(px, py, (a % 2 ? 1 : -1) * C.mergeSwirl * m, R * 0.2);
        this._radialBurst(px, py, C.mergePulse * m * Math.sin(this.time * 3 + a), R * 0.16);
        this.addDye(px, py, C.mergeDye * m, R * 0.14);
      }
      // A central counter-rotation binds the arms into one spinning core.
      this._swirl(cx, cy, -C.mergeSwirl * 0.6 * m, R * 0.45);
    }

    /* =========================================================
       AUDIO -> FLUID coupling
       Audio features never move particles directly. The song's actual
       filtered spectrum is emitted from the SURFACE of a central
       black-hole core (see _emitCoreSpectrum), which also pulls the
       fluid inward and spins an accretion current around itself.
       ========================================================= */
    injectAudioForces(A) {
      const C = this.config;
      const g = this.forceGain;
      const f = this.dt * 60;
      const t = this.time;
      const W = this.pxW, H = this.pxH;
      const cx = W * 0.5, cy = H * 0.5;
      const base = Math.min(W, H);
      const m = this._mergeFactor;                 // flare envelope, 0..1

      // Refresh the core descriptor (read by particles + renderer).
      const r0 = base * C.coreRadius;
      this.core.x = cx;
      this.core.y = cy;
      this.core.r = r0;
      this.core.pull = C.corePullParticles * (1 + 1.2 * m);

      // ---- Spectrum surface waves (see _emitCoreSpectrum) ----
      const amp = (C.coreAmpBase + A.rms * C.coreAmpRms + A.bass * C.coreAmpBass + A.onsetStrength * C.coreAmpOnset)
        * g * (1 + 0.3 * m);                       // the flare drives the waves a little harder
      const omega = C.waveOmegaBase + A.energy * C.waveOmegaGain;
      if (A.spectrum && (A.rms > 0.004 || A.energy > 0.004)) {
        this._emitCoreSpectrum(cx, cy, r0, base * C.coreReach, amp, omega, A.spectrum, f);
      }

      // ---- Gravity: a steady inflow toward the hole. Projection cancels
      // most of a pure sink (incompressibility), but the transient acts on
      // advection every frame and the residual biases the flow inward; the
      // direct tracer pull in particle-system.js does the visible rest.
      const pull = C.corePull * (0.5 + A.energy) * g * f * (1 + 0.8 * m);
      this._radialBurst(cx, cy, -pull, base * 0.9);

      // ---- Accretion rotation: a slow whirlpool centered on the hole.
      // Rotation is divergence-free, so projection preserves it — this is
      // what keeps particles orbiting instead of piling up at the edges.
      // The spin speed eases between values (never abruptly flips).
      const swirl = (C.coreSwirl + A.lowMid * C.coreSwirlLowMid) * g * f;
      const spin = 0.65 + 0.35 * Math.sin(t * C.driftTurnRate);
      this._swirl(cx, cy, swirl * spin, Math.hypot(W, H) * 0.55);

      // ---- Flare bloom (periodic showpiece; B key triggers it now) ----
      if (m > 0.01) this._emitMergeBloom(cx, cy, W * 0.22, base * 0.62, m);

      // --- Sub-bass: slow global breathing pressure (smooth, non-random) ---
      const breath = Math.sin(t * 0.7) * A.sub * C.subBreathGain * g * f;
      if (Math.abs(breath) > 0.01) this._radialBurst(cx, cy, breath, base * 0.95);
    }

    /* =========================================================
       POINTER -> FLUID coupling
       pointer: { x, y, px, py, active, down }  (px/py = previous pos)
       ========================================================= */
    injectPointerForces(pointer) {
      if (!pointer || !pointer.active) return;
      const C = this.config;
      const g = this.forceGain;
      const f = this.dt * 60;
      const dvx = pointer.x - pointer.px;
      const dvy = pointer.y - pointer.py;
      // Drag force along pointer motion.
      this.addForce(pointer.x, pointer.y, dvx * C.pointerDrag * g, dvy * C.pointerDrag * g, C.pointerRadius);
      // Local vortex so the flow curls around the cursor.
      this._swirl(pointer.x, pointer.y, C.pointerSwirl * g * f, C.pointerRadius);
      if (pointer.down) {
        this._radialBurst(pointer.x, pointer.y, C.pointerBurst * g, C.pointerRadius * 1.6);
        this.addDye(pointer.x, pointer.y, 1.6, C.pointerRadius);
      }
    }

    /* =========================================================
       HAND -> FLUID coupling (camera / MediaPipe)
       hands: [{ palm, tips, span, pose }]
         palm  : { x, y, px, py }            smoothed palm anchor (screen px)
         tips  : [{ x, y, px, py, spin }]    5 fingertips (thumb→pinky)
         span  : hand size in px (scales the gesture footprints)
         pose  : "neutral" | "open" | "fist" | "pinch"
       Every point always does a gentle stir (so a still hand keeps the
       fluid breathing); the recognised POSE adds a showpiece animation.
       ========================================================= */
    injectHandForces(hands) {
      if (!hands || !hands.length) return;
      const C = this.config;
      const g = this.forceGain;
      const f = this.dt * 60;                 // frame-rate normalization
      const gp = Math.max(g, 0.45);           // gesture floor — poses pop even at low intensity

      for (let h = 0; h < hands.length; h++) {
        const hand = hands[h];
        const palm = hand.palm;
        const span = hand.span || 120;

        // --- Baseline stir at the palm + each fingertip (works even at rest) ---
        this._handStir(palm, true, +1, g, f, C);
        for (let i = 0; i < hand.tips.length; i++) {
          const tip = hand.tips[i];
          this._handStir(tip, false, tip.spin, g, f, C);
        }

        // --- Pose-driven showpiece animations ---
        if (hand.pose === "open") {
          // ✋ Aura: an outward shockwave + bright bloom radiating from the palm.
          const R = clamp(span * 1.6, 110, 380);
          this._radialBurst(palm.x, palm.y, C.gestureOpenPush * gp * f, R);
          this.addDye(palm.x, palm.y, C.gestureOpenDye * f, R * 0.8);
        } else if (hand.pose === "fist") {
          // ✊ Vortex: suck particles inward and spin them into a tight knot.
          const R = clamp(span * 1.3, 90, 320);
          this._radialBurst(palm.x, palm.y, -C.gestureFistPull * gp * f, R);   // inward
          this._swirl(palm.x, palm.y, C.gestureFistSwirl * gp * f, R * 0.7);
          this.addDye(palm.x, palm.y, C.gestureFistDye * f, R * 0.5);
        } else if (hand.pose === "pinch") {
          // 🤏 Spark: a sharp burst at the pinch point (thumb–index midpoint).
          const t0 = hand.tips[0], t1 = hand.tips[1];
          const sx = (t0.x + t1.x) * 0.5, sy = (t0.y + t1.y) * 0.5;
          const R = clamp(span * 0.5, 45, 150);
          this._radialBurst(sx, sy, C.gesturePinchBurst * gp * f, R);
          this.addDye(sx, sy, C.gesturePinchDye * f, R * 0.7);
        }
      }

      // --- ✋✋ Two open palms: a turbulent "energy bridge" between the hands ---
      if (hands.length === 2 && hands[0].pose === "open" && hands[1].pose === "open") {
        const a = hands[0].palm, b = hands[1].palm;
        const mx = (a.x + b.x) * 0.5, my = (a.y + b.y) * 0.5;
        const R = clamp(Math.hypot(a.x - b.x, a.y - b.y) * 0.45, 80, 420);
        this._swirl(mx, my, C.gestureBridgeSwirl * gp * f, R);
        this.addDye(mx, my, C.gestureOpenDye * 0.6 * f, R * 0.7);
      }
    }

    // One stir point's gentle baseline contribution (drag + steady swirl + dye).
    _handStir(p, isPalm, spin, g, f, C) {
      const radius = isPalm ? C.handPalmRadius : C.handRadius;
      const dvx = p.x - p.px, dvy = p.y - p.py;
      this.addForce(p.x, p.y, dvx * C.handDrag * g, dvy * C.handDrag * g, radius);
      const swirl = (isPalm ? C.handPalmSwirl : C.handSwirl) * (spin || 1);
      this._swirl(p.x, p.y, swirl * g * f, radius);
      this.addDye(p.x, p.y, (isPalm ? C.handPalmDye : C.handDye) * f, radius);
    }

    /* =========================================================
       VORTICITY
       ω = ∂u_y/∂x - ∂u_x/∂y   (scalar curl in 2D)
       Confinement re-injects energy into swirling regions so
       eddies and vortex filaments stay crisp instead of diffusing.
       f_vorticity = ε * (N × ω),  N = normalize(∇|ω|)
       ========================================================= */
    computeCurl() {
      const W = this.W, H = this.H, u = this.u, v = this.v, curl = this.curl;
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          curl[idx] = 0.5 * ((v[idx + 1] - v[idx - 1]) - (u[idx + W] - u[idx - W]));
        }
      }
      this._setBnd(0, curl);
    }

    _applyVorticityConfinement() {
      const e = this._vortStrength;
      if (e <= 0) return;
      const W = this.W, H = this.H, curl = this.curl, u = this.u, v = this.v;
      const f = this.dt * 60;
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          const dwdx = Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1]);
          const dwdy = Math.abs(curl[idx + W]) - Math.abs(curl[idx - W]);
          const len = Math.sqrt(dwdx * dwdx + dwdy * dwdy) + 1e-5;
          const nx = dwdx / len, ny = dwdy / len;
          const w = curl[idx];
          // perpendicular (N × ω) in 2D: (ny, -nx) * ω
          u[idx] += e * ny * w * f;
          v[idx] += e * -nx * w * f;
        }
      }
    }

    /* =========================================================
       PROCEDURAL TURBULENCE (ambient curl-noise force field)
       Keeps a structured calm drift while quiet; high-mid energy
       turns it into sharp shear / local instability.
       ========================================================= */
    _noiseAngle(x, y, t) {
      const s = 0.0018;
      return (
        Math.sin(x * s + t * 0.30) +
        Math.cos(y * s * 1.3 - t * 0.22) +
        Math.sin((x + y) * s * 0.6 + t * 0.17)
      ) * 1.7;
    }

    _applyProceduralTurbulence() {
      const amp = this._turbAmp;
      if (amp <= 0) return;
      const W = this.W, H = this.H, scale = this.scale, u = this.u, v = this.v;
      const t = this.time;
      const f = this.dt * 60;
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const px = (i - 0.5) * scale, py = (j - 0.5) * scale;
          const a = this._noiseAngle(px, py, t);
          const idx = i + j * W;
          u[idx] += Math.cos(a) * amp * f;
          v[idx] += Math.sin(a) * amp * f;
        }
      }
    }

    /* =========================================================
       ADVECTION  (semi-Lagrangian, unconditionally stable)
       Trace each cell's position backward along the velocity field
       and sample the old field there.
       ========================================================= */
    advectVelocity(dt) {
      const W = this.W, H = this.H, scale = this.scale;
      const u = this.u, v = this.v, u0 = this.u0, v0 = this.v0;
      u0.set(u);
      v0.set(v);
      const dtg = dt / scale; // px/s -> grid cells of back-displacement
      const dissip = Math.exp(-this.config.velocityDissipation * dt);
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          let x = i - dtg * u0[idx];
          let y = j - dtg * v0[idx];
          u[idx] = this._sampleGrid(u0, x, y) * dissip;
          v[idx] = this._sampleGrid(v0, x, y) * dissip;
        }
      }
      this._setBnd(1, u);
      this._setBnd(2, v);
    }

    _advectDye(dt) {
      const W = this.W, H = this.H, scale = this.scale;
      const dye = this.dye, dye0 = this.dye0, u = this.u, v = this.v;
      dye0.set(dye);
      const dtg = dt / scale;
      const fade = Math.exp(-this.config.dyeDissipation * dt);
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          let x = i - dtg * u[idx];
          let y = j - dtg * v[idx];
          dye[idx] = this._sampleGrid(dye0, x, y) * fade;
        }
      }
      this._setBnd(0, dye);
    }

    /* =========================================================
       DIFFUSION  (viscosity ν∇²u via Gauss–Seidel relaxation)
       Solves (I - νΔt∇²) u_new = u_old.
       ========================================================= */
    diffuseVelocity(dt) {
      const visc = this._viscosity;
      const W = this.W, H = this.H;
      const a = dt * visc * (W - 2) * (H - 2);
      if (a < 1e-7) return; // negligible -> skip
      const u = this.u, v = this.v, u0 = this.u0, v0 = this.v0;
      u0.set(u);
      v0.set(v);
      const denom = 1 / (1 + 4 * a);
      for (let k = 0; k < this.config.diffuseIterations; k++) {
        for (let j = 1; j < H - 1; j++) {
          for (let i = 1; i < W - 1; i++) {
            const idx = i + j * W;
            u[idx] = (u0[idx] + a * (u[idx - 1] + u[idx + 1] + u[idx - W] + u[idx + W])) * denom;
            v[idx] = (v0[idx] + a * (v[idx - 1] + v[idx + 1] + v[idx - W] + v[idx + W])) * denom;
          }
        }
        this._setBnd(1, u);
        this._setBnd(2, v);
      }
    }

    /* =========================================================
       PROJECTION  (make velocity approximately divergence-free)
         div(u) = ∂u_x/∂x + ∂u_y/∂y
         ∇²p = div                      (Jacobi iterations)
         u = u - ∇p
       ========================================================= */
    computeDivergence() {
      const W = this.W, H = this.H, u = this.u, v = this.v, div = this.div, p = this.p;
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          div[idx] = 0.5 * ((u[idx + 1] - u[idx - 1]) + (v[idx + W] - v[idx - W]));
          p[idx] = 0;
        }
      }
      this._setBnd(0, div);
      this._setBnd(0, p);
    }

    solvePressure(iterations) {
      // Gauss–Seidel relaxation of the pressure Poisson equation ∇²p = div.
      // Same per-cell update as the Jacobi formula
      //     p_new = (p_left + p_right + p_bottom + p_top - divergence) / 4
      // but applied in place (reading already-updated neighbors), which
      // converges far faster per sweep — so a modest iteration count is
      // enough to make the motion look genuinely fluid.
      const W = this.W, H = this.H, div = this.div, p = this.p;
      for (let k = 0; k < iterations; k++) {
        for (let j = 1; j < H - 1; j++) {
          for (let i = 1; i < W - 1; i++) {
            const idx = i + j * W;
            p[idx] = (p[idx - 1] + p[idx + 1] + p[idx - W] + p[idx + W] - div[idx]) * 0.25;
          }
        }
        this._setBnd(0, p);
      }
    }

    subtractPressureGradient() {
      const W = this.W, H = this.H, u = this.u, v = this.v, p = this.p;
      for (let j = 1; j < H - 1; j++) {
        for (let i = 1; i < W - 1; i++) {
          const idx = i + j * W;
          u[idx] -= 0.5 * (p[idx + 1] - p[idx - 1]);
          v[idx] -= 0.5 * (p[idx + W] - p[idx - W]);
        }
      }
      this._setBnd(1, u);
      this._setBnd(2, v);
    }

    project() {
      this.computeDivergence();
      this.solvePressure(this.config.pressureIterations);
      this.subtractPressureGradient();
    }

    /* =========================================================
       STEP — the full stable-fluids pipeline for one frame.
       ========================================================= */
    step(dt, audio, pointer, hands) {
      this.dt = dt;
      this.time += dt;
      const C = this.config;

      // Advance the bonding animation (updates speaker positions / merge state).
      this.updateBond(dt);

      // Derive audio-modulated material parameters for this frame.
      const energyN = audio ? clamp(audio.energy, 0, 1) : 0;
      this._viscosity = mix(C.viscHigh, C.viscLow, energyN);   // viscosity = mix(high, low, energy)
      this._vortStrength = C.vorticity +
        (audio ? audio.mid * C.midVortGain + audio.flux * C.fluxVortGain : 0);
      this._turbAmp = (C.turbBase + (audio ? audio.highMid * C.turbHighMidGain : 0)) * this.forceGain;

      // 1. ADD FORCES (audio emitters, pointer, procedural turbulence, vorticity)
      if (audio) this.injectAudioForces(audio);
      if (pointer) this.injectPointerForces(pointer);
      if (hands) this.injectHandForces(hands);
      this._applyProceduralTurbulence();
      this.computeCurl();
      this._applyVorticityConfinement();

      // 2. ADVECT VELOCITY
      this.advectVelocity(dt);

      // 3. DIFFUSE VELOCITY
      this.diffuseVelocity(dt);

      // 4. PROJECT (approximate incompressibility)
      this.project();

      // 5. DYE transport + recompute ω for sampling/coloring
      this._advectDye(dt);
      this.computeCurl();
    }
  }

  Aether.FluidField = FluidField;
})((window.Aether = window.Aether || {}));
