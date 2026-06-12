/* ============================================================
   Aether Field — app.js
   ------------------------------------------------------------
   Orchestrates the whole visualizer:

     audio  -> FeatureExtractor -> FluidField (force injection)
            -> ParticleSystem (advection) + field glow -> Canvas

   Each frame:
     1. extract audio features  A(t)
     2. fluid.step(dt, A, pointer)          (stable-fluids pipeline)
     3. particles.update(dt, fluid, A)      (advect tracers)
     4. render: trail fade -> field plasma glow -> particles

   Everything runs client-side; no backend, no API keys.
   ============================================================ */

(function (Aether) {
  "use strict";

  const { ColorMapper, FluidField, FeatureExtractor, AudioEngine, ParticleSystem, UIController, HandTracker } = Aether;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const isMobile =
    /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    Math.min(window.innerWidth, window.innerHeight) < 560;

  const CONFIG = {
    targetGridW: isMobile ? 84 : 132,   // sim grid width (96..180 range honored on desktop)
    dprCap: isMobile ? 1.5 : 2,
    // Particles per megapixel. The cap below must stay ABOVE the top tiers ×
    // a typical screen area, otherwise every tier clamps to the same count
    // and the density buttons do nothing.
    density: { low: 700, medium: 1800, high: 3600, extra_high: 6500, too_much: 11000 },
    maxParticles: isMobile ? 2600 : 22000,
    trailFade: 0.14,
    brightness: 1.0,                     // master brightness dial (lower = dimmer everything)
    fieldGlowAlpha: 0.16,                // strength of the low-res plasma layer (lower = dimmer)
    // velRef is the velocity (px/s) that reads as "fully hot/bright". Set high
    // so loud music doesn't drive the *whole* field to max (which blew out to
    // white); only the fastest streaks go hot, the rest stay cool & colorful.
    velRef: 520,
    vortRef: 7,
  };

  // Feature vector used before any audio is activated (calm idle drift).
  const IDLE_FEATURES = {
    rms: 0, sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
    centroid: 0, flux: 0, onset: 0, onsetStrength: 0, energy: 0,
    spectrum: new Float32Array(48),   // silent spectrum -> dormant black hole
  };

  /* ---------------- Canvas ---------------- */
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d", { alpha: true });

  const state = {
    width: 0, height: 0, dpr: 1, time: 0,
    intensity: 0.25, densityKey: "medium", audioActive: false, mode: "upload",
  };

  const pointer = { x: -9999, y: -9999, px: -9999, py: -9999, active: false, down: false };

  /* ---------------- Core modules ---------------- */
  const colorMapper = new ColorMapper(256);
  const particles = new ParticleSystem(colorMapper);
  particles.config.velRef = CONFIG.velRef;
  particles.config.vortRef = CONFIG.vortRef;
  particles.config.brightness = CONFIG.brightness;

  const audioEngine = new AudioEngine();
  const audioEl = document.getElementById("audio");

  // Hand tracking (camera) — independent input that runs alongside audio.
  const handTracker = new HandTracker();
  const handVideo = document.getElementById("handVideo");
  const handOverlay = document.getElementById("handOverlay");

  let fluid = null;
  let featureExtractor = null;

  // Low-res offscreen canvas for the fluid plasma glow.
  const glowCanvas = document.createElement("canvas");
  const glowCtx = glowCanvas.getContext("2d");
  let glowImage = null;

  /* ---------------- Sizing ---------------- */
  function computeScale(w) {
    return Math.max(4, Math.round(w / CONFIG.targetGridW));
  }

  function targetParticleCount() {
    const mp = (state.width * state.height) / 1e6;
    const n = Math.round(CONFIG.density[state.densityKey] * mp);
    return Math.max(60, Math.min(CONFIG.maxParticles, n));
  }

  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.dprCap);
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    canvas.style.width = state.width + "px";
    canvas.style.height = state.height + "px";
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const scale = computeScale(state.width);
    if (!fluid) {
      fluid = new FluidField(state.width, state.height, scale);
    } else {
      fluid.scale = scale;
      fluid.resize(state.width, state.height);
    }
    _syncGlowCanvas();
    particles.setView(state.width, state.height);
    handTracker.setView(state.width, state.height);
  }

  function _syncGlowCanvas() {
    if (glowCanvas.width !== fluid.W || glowCanvas.height !== fluid.H) {
      glowCanvas.width = fluid.W;
      glowCanvas.height = fluid.H;
      glowImage = glowCtx.createImageData(fluid.W, fluid.H);
      // Pre-fill alpha bytes; we overwrite RGB + A every frame.
      glowImage.data.fill(0);
    }
  }

  function rebuildParticles() {
    particles.rebuild(targetParticleCount(), state.width, state.height);
  }

  /* ---------------- Pointer ---------------- */
  function pointerMove(x, y) {
    if (!pointer.active) { pointer.px = x; pointer.py = y; }
    pointer.x = x; pointer.y = y; pointer.active = true;
  }
  function pointerLeave() { pointer.active = false; pointer.down = false; }

  canvas.addEventListener("mousemove", (e) => pointerMove(e.clientX, e.clientY));
  canvas.addEventListener("mouseleave", pointerLeave);
  canvas.addEventListener("mousedown", (e) => { pointerMove(e.clientX, e.clientY); pointer.down = true; });
  window.addEventListener("mouseup", () => { pointer.down = false; });
  canvas.addEventListener("touchmove", (e) => {
    const t = e.touches[0]; if (t) pointerMove(t.clientX, t.clientY);
  }, { passive: true });
  canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; if (t) { pointerMove(t.clientX, t.clientY); pointer.down = true; }
  }, { passive: true });
  canvas.addEventListener("touchend", () => { pointer.down = false; pointer.active = false; }, { passive: true });

  /* ---------------- Field plasma glow ---------------- */
  function renderFieldGlow(features) {
    const W = fluid.W, H = fluid.H;
    const u = fluid.u, v = fluid.v, curl = fluid.curl, dye = fluid.dye;
    const data = glowImage.data;
    const co = particles.config.coeff;
    const velRef = CONFIG.velRef, vortRef = CONFIG.vortRef;
    const lut = colorMapper.lut, lutN = colorMapper.lutSize;

    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const idx = i + j * W;
        const spd = Math.hypot(u[idx], v[idx]);
        const velN = clamp(spd / velRef, 0, 1);
        const vortN = clamp(Math.abs(curl[idx]) / vortRef, 0, 1);
        const d = dye[idx];
        const T = clamp(
          co.a * velN + co.b * vortN + co.c * features.treble + co.d * features.flux + co.e * features.centroid,
          0, 1
        );
        const li = Math.min(lutN - 1, (T * (lutN - 1)) | 0) * 3;
        // Soft exposure tone-map: asymptotes toward ~1 instead of clipping
        // hard to white, so loud passages stay rich rather than blown out.
        const a = 1 - Math.exp(-(d * 0.5 + velN * 0.42));
        const o = idx * 4;
        data[o] = lut[li];
        data[o + 1] = lut[li + 1];
        data[o + 2] = lut[li + 2];
        data[o + 3] = (a * 255) | 0;
      }
    }
    glowCtx.putImageData(glowImage, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = CONFIG.fieldGlowAlpha * CONFIG.brightness;
    ctx.drawImage(glowCanvas, 0, 0, state.width, state.height);
    ctx.globalAlpha = 1;
  }

  /* ---------------- Black-hole core ---------------- */
  // The dark disc is the event horizon; the rim is a circular spectrum
  // analyzer (bass at the bottom, treble at the top, mirrored left/right)
  // that matches the surface waves injected into the fluid, so what you
  // see on the ball is exactly what's pushing the particles.
  function renderCore(features) {
    const core = fluid.core;
    if (!core || !core.r) return;
    const spec = features.spectrum;
    const flare = fluid.flareFactor || 0;
    // The horizon breathes slightly with sub-bass and beats.
    const r = core.r * (1 + features.sub * 0.04 + features.onsetStrength * 0.05);

    // Void disc — opaque darkness with a soft edge.
    ctx.globalCompositeOperation = "source-over";
    const grad = ctx.createRadialGradient(core.x, core.y, r * 0.5, core.x, core.y, r);
    grad.addColorStop(0, "rgba(2,3,10,0.97)");
    grad.addColorStop(0.85, "rgba(2,3,10,0.92)");
    grad.addColorStop(1, "rgba(2,3,10,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(core.x, core.y, r, 0, Math.PI * 2);
    ctx.fill();

    if (!spec || !spec.length) return;
    // Spectrum rim: short additive arc segments around the horizon. The
    // angle->band mapping is IDENTICAL to _emitCoreSpectrum (position
    // (sin a, cos a): a = 0 is the bottom = bass, |a| = π is the top =
    // treble), the radius bulges with the band's energy (equalizer ring),
    // and the hue walks the palette from cool bass to hot treble.
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    const SEG = 96;
    const N = spec.length;
    const boost = 1 + flare * 1.2;
    let px = 0, py = 0;
    for (let s = 0; s <= SEG; s++) {
      const a = -Math.PI + (s / SEG) * Math.PI * 2;
      const frac = Math.abs(a) / Math.PI;
      const bp = frac * (N - 1);
      const b0 = bp | 0;
      const m = spec[b0] + (spec[Math.min(N - 1, b0 + 1)] - spec[b0]) * (bp - b0);
      const R = r * (1.02 + 0.28 * m);
      const x = core.x + Math.sin(a) * R;
      const y = core.y + Math.cos(a) * R;
      if (s > 0) {
        // Base hue walks the palette with frequency; a hot band flares
        // toward the white-gold end (otherwise loud bass stays deep blue
        // and reads as nothing).
        const c = colorMapper.colorAt(Math.min(0.98, 0.08 + 0.5 * frac + 0.4 * m));
        const alpha = Math.min(1, (0.10 + 0.9 * m) * boost) * CONFIG.brightness;
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
        ctx.lineWidth = 1.5 + 4.5 * m;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      px = x; py = y;
    }
  }

  /* ---------------- Main loop ---------------- */
  let lastTime = performance.now();

  function frame(now) {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.05) dt = 0.05;       // clamp after tab switches
    if (dt <= 0) dt = 1 / 60;
    state.time += dt;

    // 1. Audio features
    let features;
    if (featureExtractor) {
      features = state.audioActive ? featureExtractor.update(dt) : featureExtractor.idle(dt);
    } else {
      features = IDLE_FEATURES;
    }

    // 2. Fluid step (audio emitters + mouse/touch pointer + hand stir points)
    fluid.forceGain = state.intensity;
    const hands = handTracker.active ? handTracker.update() : null;
    fluid.step(dt, features, pointer.active ? pointer : null, hands);
    pointer.px = pointer.x; pointer.py = pointer.y;

    // 3. Particle advection
    particles.update(dt, fluid, features);

    // 4. Render — fade trails toward TRANSPARENT (destination-out) rather than
    // painting an opaque color: the canvas stays see-through where nothing
    // glows, so the layered CSS background (gradient + breathing glow) shows
    // through behind the particles instead of being covered by a black plate.
    const fade = CONFIG.trailFade + features.energy * 0.10;
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, state.width, state.height);

    ctx.globalCompositeOperation = "lighter";
    renderFieldGlow(features);
    particles.draw(ctx, fluid, features, state.time, state.intensity);
    renderCore(features);

    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  }

  /* ---------------- Audio activation helpers ---------------- */
  function ensureExtractor() {
    if (!featureExtractor && audioEngine.analyser) {
      featureExtractor = new FeatureExtractor(audioEngine.analyser);
    }
  }

  /* ---------------- Playback queue ---------------- */
  const queue = [];          // [{ name, url }]
  let currentIndex = -1;
  let ui;

  // Demo tracks shipped in songs/ — pre-queued so the site plays with one
  // click (sources are credited in the panel's copyright notice).
  const PRESET_TRACKS = [
    {
      name: "STEREO LOVE 2 (Slowed)",
      url: encodeURI("songs/STEREO LOVE 2 (Slowed).mp3"),
    },
    {
      name: "Don't Let Me Down (slowed & reverb)",
      url: encodeURI("songs/The Chainsmokers, Daya - Don't Let Me Down  (slowed & reverb).mp3"),
    },
  ];

  function refreshTransport() {
    ui.enableTransport(
      queue.length > 0,
      currentIndex > 0,
      currentIndex >= 0 && currentIndex < queue.length - 1
    );
    ui.renderQueue(queue, currentIndex);
  }

  function loadTrack(i) {
    if (i < 0 || i >= queue.length) return;
    currentIndex = i;
    audioEl.src = queue[i].url;
    audioEl.load();
    ui.setTrackName(queue[i].name);
    ui.setProgress(0, 0);
    refreshTransport();
  }

  async function playCurrent() {
    if (currentIndex < 0) return;
    audioEngine.ensureContext();
    await audioEngine.resume();
    audioEngine.connectMusic(audioEl);
    ensureExtractor();
    try { await audioEl.play(); }
    catch (e) { ui.setStatus("blocked", "Playback blocked"); }
  }

  /* ---------------- UI handlers ---------------- */
  const handlers = {
    onUploadFiles(files) {
      // Auto-play the first added track if nothing has been played yet
      // (the preset demo tracks may already be sitting in the queue).
      const firstPlay = currentIndex < 0 || audioEl.paused;
      const start = queue.length;
      for (const f of files) queue.push({ name: f.name, url: URL.createObjectURL(f) });
      if (firstPlay) { loadTrack(start); playCurrent(); }
      else refreshTransport();
      ui.setStatus("idle", "Ready");
    },

    async onTogglePlay() {
      if (currentIndex < 0) {
        if (queue.length) loadTrack(0); else return;
      }
      audioEngine.ensureContext();
      await audioEngine.resume();
      audioEngine.connectMusic(audioEl);
      ensureExtractor();
      if (audioEl.paused) {
        try { await audioEl.play(); }
        catch (e) { ui.setStatus("blocked", "Playback blocked"); }
      } else {
        audioEl.pause();
      }
    },

    onNext() {
      if (currentIndex < queue.length - 1) { loadTrack(currentIndex + 1); playCurrent(); }
    },
    onPrev() {
      // Restart the current track if we're past 3s, otherwise go to the previous.
      if (audioEl.currentTime > 3 || currentIndex <= 0) { audioEl.currentTime = 0; }
      else { loadTrack(currentIndex - 1); playCurrent(); }
    },
    onSelectTrack(i) { loadTrack(i); playCurrent(); },
    onRemoveTrack(i) {
      if (i < 0 || i >= queue.length) return;
      URL.revokeObjectURL(queue[i].url);
      const wasCurrent = i === currentIndex;
      const wasPlaying = !audioEl.paused;
      queue.splice(i, 1);
      if (queue.length === 0) {
        currentIndex = -1;
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.load();
        ui.setTrackName("No track loaded");
        ui.setProgress(0, 0);
        refreshTransport();
        return;
      }
      if (i < currentIndex) {
        currentIndex--;
      } else if (wasCurrent) {
        currentIndex = Math.min(currentIndex, queue.length - 1);
        loadTrack(currentIndex);
        if (wasPlaying) playCurrent();
      }
      refreshTransport();
    },
    onSeek(frac) {
      if (isFinite(audioEl.duration) && audioEl.duration > 0) {
        audioEl.currentTime = frac * audioEl.duration;
      }
    },

    onVolume(v) { audioEl.volume = v; },
    onIntensity(v) { state.intensity = v; },
    onDensity(key) { state.densityKey = key; rebuildParticles(); },
    onMergeToggle(on) { if (fluid) fluid.setBondEnabled(on); },
    onTriggerMerge() { if (fluid) fluid.triggerBond(); },

    // Hand control is a toggle that lives ALONGSIDE the audio source — turning
    // it on/off never touches playback. The camera + model load lazily here.
    async onHandToggle(on) {
      // start()/stop() are idempotent and re-entrancy-guarded, so it's safe to
      // call these even while a previous start is still loading the model.
      if (on) {
        ui.setHandActive(true);                 // reveal the preview while we start
        try {
          await handTracker.start(handVideo, handOverlay);
        } catch (e) {
          ui.setHandActive(false);
          ui.setStatus("blocked", handTracker.errorText(e));
        }
      } else {
        handTracker.stop();
        ui.setHandActive(false);
      }
    },

    async onMode(mode) {
      state.mode = mode;
      if (mode === "upload") {
        audioEngine.stopCapture();
        state.audioActive = !audioEl.paused && !!audioEl.src;
        ui.setStatus(state.audioActive ? "playing" : "idle", state.audioActive ? "Playing" : "Idle");
        return;
      }
      // mic / system: stop the file + any other capture first.
      if (!audioEl.paused) audioEl.pause();
      audioEngine.stopCapture();
      state.audioActive = false;

      if (mode === "mic") {
        ui.setStatus("idle", "Requesting microphone…");
        try {
          await audioEngine.startMic();
          ensureExtractor();
          state.audioActive = true;
          ui.setStatus("listening", "Listening (mic)");
        } catch (e) {
          state.audioActive = false;
          ui.setStatus("blocked", "Microphone blocked");
        }
      } else if (mode === "system") {
        ui.setStatus("idle", "Choose a tab/window & enable “Share audio”…");
        try {
          await audioEngine.startSystem();
          audioEngine.onSystemEnded = () => {
            state.audioActive = false;
            ui.setStatus("idle", "System capture ended");
          };
          ensureExtractor();
          state.audioActive = true;
          ui.setStatus("listening", "Capturing system audio");
        } catch (e) {
          state.audioActive = false;
          ui.setStatus(
            "blocked",
            e && e.message === "no-audio-track" ? "No audio shared — tick “Share audio”" : "System capture blocked"
          );
        }
      }
    },
  };

  /* ---------------- Audio element events ---------------- */
  audioEl.addEventListener("play", () => {
    if (state.mode === "upload") { state.audioActive = true; ui.setPlaying(true); ui.setStatus("playing", "Playing"); }
  });
  audioEl.addEventListener("pause", () => {
    ui.setPlaying(false);
    if (state.mode === "upload") { state.audioActive = false; ui.setStatus("idle", "Paused"); }
  });
  audioEl.addEventListener("ended", () => {
    ui.setPlaying(false);
    // Auto-advance the queue; stop at the end of the last track.
    if (currentIndex < queue.length - 1) {
      loadTrack(currentIndex + 1);
      playCurrent();
    } else if (state.mode === "upload") {
      state.audioActive = false;
      ui.setStatus("idle", "Idle");
    }
  });
  audioEl.addEventListener("error", () => {
    if (!audioEl.src) return;            // ignore the reset after clearing the queue
    ui.setPlaying(false);
    if (state.mode === "upload") {
      state.audioActive = false;
      ui.setStatus("blocked", "Can't play this track");
    }
  });
  // Seek bar + time labels.
  audioEl.addEventListener("loadedmetadata", () => ui.setProgress(audioEl.currentTime, audioEl.duration));
  audioEl.addEventListener("durationchange", () => ui.setProgress(audioEl.currentTime, audioEl.duration));
  audioEl.addEventListener("timeupdate", () => ui.setProgress(audioEl.currentTime, audioEl.duration));

  /* ---------------- Resize (debounced particle rebuild) ---------------- */
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuildParticles, 200);
  });

  /* ---------------- Init ---------------- */
  function init() {
    resize();
    rebuildParticles();
    ui = new UIController(handlers);
    // Route hand-tracker status messages into the camera preview caption.
    handTracker.onStatus = (text) => ui.setHandStatus(text);
    // HTML sliders are the source of truth for their defaults.
    audioEl.volume = parseFloat(document.getElementById("volume").value || "0.25");
    state.intensity = parseFloat(document.getElementById("intensity").value || "0.25");
    // Pre-queue the demo tracks and cue up the first one. Playback still
    // waits for a click (browsers block autoplay until a user gesture).
    queue.push(...PRESET_TRACKS);
    loadTrack(0);
    ui.setStatus("idle", "Idle");
    requestAnimationFrame((t) => { lastTime = t; frame(t); });
  }

  init();
})((window.Aether = window.Aether || {}));
