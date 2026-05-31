/* ============================================================
   Aether Field — hand-tracker.js
   ------------------------------------------------------------
   Optional camera-driven input that lets the user STIR the fluid
   with their bare hands, powered by Google MediaPipe's Hand
   Landmarker (the "tasks-vision" web runtime).

   It is deliberately INDEPENDENT of the audio source: the webcam
   tracker can run at the same time as Upload / Mic / System audio,
   so you can conduct the field with your hands while music plays.

   Pipeline:
     webcam <video> ──▶ HandLandmarker.detectForVideo()
        └▶ 21 landmarks / hand ──▶ stir points (fingertips + palm)
                              ──▶ FluidField.injectHandForces()

   Everything runs client-side. The MediaPipe runtime + model are
   fetched lazily from a CDN the first time you turn the feature on
   (then cached by the browser), so the rest of the app keeps
   working offline / from file://.
   ============================================================ */

(function (Aether) {
  "use strict";

  // Pinned MediaPipe Tasks-Vision build (bump to upgrade the runtime/model).
  const MP_VERSION = "0.10.35";
  const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
  const MP_WASM   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  // Google-hosted hand model (float16 ≈ 7.8 MB, cached after first load).
  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

  // Landmark indices (MediaPipe Hands topology).
  const WRIST = 0, PALM = 9, MIDDLE_TIP = 12; // 9 = middle-finger MCP ≈ palm center
  const THUMB_TIP = 4, INDEX_TIP = 8;
  // Fingertips used as fine stir points, each with an alternating swirl sign
  // so neighbouring fingers spin opposite vortices (richer turbulence).
  const FINGERTIPS = [
    [THUMB_TIP, +1], [INDEX_TIP, -1], [12, +1], [16, -1], [20, +1],
  ];
  // [tip, pip] pairs per finger (index → pinky) for the "extended" test:
  // a finger is extended when its tip sits farther from the wrist than its PIP.
  const FINGER_JOINTS = [[8, 6], [12, 10], [16, 14], [20, 18]];

  class HandTracker {
    constructor() {
      this.active = false;          // tracking on (camera + model live)
      this._starting = false;       // start() in flight (model still loading)
      this._stopRequested = false;  // stop() called during start()
      this.landmarker = null;
      this.video = null;            // <video> showing the webcam (also the preview)
      this.overlay = null;          // optional <canvas> for the landmark overlay
      this.overlayCtx = null;
      this.drawer = null;           // MediaPipe DrawingUtils
      this.connections = null;      // HandLandmarker.HAND_CONNECTIONS
      this.stream = null;
      this.onStatus = null;         // (text) => void  — surfaced in the UI

      this.hands = [];              // latest detection: [{ landmarks, label }]
      this.view = { w: 0, h: 0 };   // viewport size for screen-space mapping
      this._gestureKey = "";        // last reported gesture caption (avoids spam)

      this._raf = 0;
      this._lastVideoTime = -1;
      this._lastTs = 0;             // monotonic timestamp for detectForVideo
      this._tracks = new Map();     // "label:role" -> smoothed {x,y} (for velocity)

      // Tunables.
      this.smoothing = 0.5;         // EMA factor for stir points (0..1, higher = snappier)
      this.pinchRatio = 0.45;       // dist(thumb,index)/handSpan below this = pinch
    }

    setView(w, h) { this.view.w = w; this.view.h = h; }

    _status(text) { if (this.onStatus) this.onStatus(text); }

    /* ---------------- Lifecycle ---------------- */
    // videoEl / overlayEl are DOM elements owned by the page (the live preview).
    async start(videoEl, overlayEl) {
      if (this.active || this._starting) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("no-camera-api");
      }

      // Re-entrancy guard: model load takes a few seconds; a second toggle
      // (double-click / G key) must not spin up a second camera stream.
      this._starting = true;
      this._stopRequested = false;
      try {
        await this._boot(videoEl, overlayEl);
      } catch (e) {
        this._teardown();        // release any camera opened before the failure
        throw e;
      } finally {
        this._starting = false;
      }
      // If the user toggled OFF while we were loading, honor it now.
      if (this._stopRequested) this.stop();
    }

    async _boot(videoEl, overlayEl) {
      this.video = videoEl;
      this.overlay = overlayEl || null;
      this.overlayCtx = this.overlay ? this.overlay.getContext("2d") : null;

      // 1. Webcam — front camera, modest resolution (plenty for landmarks).
      this._status("Starting camera…");
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      this.video.muted = true;
      this.video.playsInline = true;
      await this.video.play();

      // 2. MediaPipe runtime + model (lazy CDN import keeps the core offline-friendly).
      this._status("Loading hand model…");
      const vision = await import(/* webpackIgnore: true */ MP_BUNDLE);
      const { HandLandmarker, FilesetResolver, DrawingUtils } = vision;
      const fileset = await FilesetResolver.forVisionTasks(MP_WASM);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      this.connections = HandLandmarker.HAND_CONNECTIONS;
      if (this.overlayCtx) this.drawer = new DrawingUtils(this.overlayCtx);

      this.active = true;
      this._gestureKey = "";
      this._status("Show your hand to the camera");
      this._tick();
    }

    stop() {
      // Called mid-load? Defer the real teardown until start() finishes booting.
      if (this._starting) { this._stopRequested = true; return; }
      this._teardown();
    }

    _teardown() {
      this.active = false;
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      this.hands = [];
      this._tracks.clear();
      this._lastVideoTime = -1;
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.video) { try { this.video.pause(); } catch (e) {} this.video.srcObject = null; }
      if (this.overlayCtx && this.overlay) {
        this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      }
      // Keep this.landmarker around so re-enabling is instant (model stays warm).
    }

    // Map any thrown error to a short, user-facing message.
    errorText(e) {
      const name = e && (e.name || e.message) || "";
      if (/NotAllowed|Permission|denied/i.test(name)) return "Camera permission blocked";
      if (/NotFound|Devices|no-camera/i.test(name)) return "No camera found";
      if (/NotReadable|TrackStart/i.test(name)) return "Camera is in use by another app";
      return "Hand tracking unavailable (needs internet)";
    }

    /* ---------------- Detection loop ---------------- */
    _tick() {
      if (!this.active) return;
      this._raf = requestAnimationFrame(() => this._tick());
      const v = this.video;
      if (!this.landmarker || !v || v.readyState < 2) return;

      // Only run the model when a new camera frame is available.
      if (v.currentTime === this._lastVideoTime) return;
      this._lastVideoTime = v.currentTime;

      // detectForVideo needs a strictly increasing timestamp (ms).
      const ts = Math.max(performance.now(), this._lastTs + 1);
      this._lastTs = ts;

      let res;
      try { res = this.landmarker.detectForVideo(v, ts); }
      catch (e) { return; }

      const out = [];
      if (res && res.landmarks) {
        for (let i = 0; i < res.landmarks.length; i++) {
          const label =
            (res.handedness && res.handedness[i] && res.handedness[i][0] &&
             res.handedness[i][0].categoryName) || ("hand" + i);
          out.push({ landmarks: res.landmarks[i], label });
        }
      }
      this.hands = out;
      // The caption (gesture name) is driven from update() each render frame.
      this._drawOverlay(res);
    }

    _drawOverlay(res) {
      if (!this.drawer || !this.overlay) return;
      const v = this.video, cv = this.overlay, ctx = this.overlayCtx;
      // Match the overlay buffer to the camera frame so normalized landmarks
      // (which DrawingUtils scales by canvas size) line up exactly.
      if (v.videoWidth && (cv.width !== v.videoWidth || cv.height !== v.videoHeight)) {
        cv.width = v.videoWidth; cv.height = v.videoHeight;
      }
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!res || !res.landmarks) return;
      for (const lm of res.landmarks) {
        this.drawer.drawConnectors(lm, this.connections, {
          color: "rgba(27,227,255,0.65)", lineWidth: 2,
        });
        this.drawer.drawLandmarks(lm, {
          color: "rgba(255,255,255,0.92)", fillColor: "rgba(106,43,255,0.9)",
          lineWidth: 1, radius: 2.5,
        });
      }
    }

    /* ---------------- Pose classification ----------------
       Works in normalized landmark space (orientation-independent).
       A finger is "extended" when its tip sits farther from the wrist
       than its PIP joint; poses are derived from how many are extended
       plus a thumb–index pinch test. */
    _classify(lm) {
      const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
      const ext = (tip, pip) => d(tip, WRIST) > d(pip, WRIST) * 1.05;
      const idx = ext(8, 6), mid = ext(12, 10), rng = ext(16, 14), pky = ext(20, 18);
      const nExt = idx + mid + rng + pky;            // booleans coerce to 0/1
      const others = mid + rng + pky;
      const span = d(WRIST, PALM) || 1e-4;
      const pinchClose = d(THUMB_TIP, INDEX_TIP) / span < this.pinchRatio;

      // Order matters: open (all up) and fist (all curled) are unambiguous; a
      // pinch is the "OK" ring — thumb meets index while other fingers stay up
      // (checked last so a closed thumb resting on a fist can't read as pinch).
      if (nExt >= 4) return "open";
      if (nExt === 0) return "fist";
      if (pinchClose && others >= 2) return "pinch";
      return "neutral";
    }

    /* ---------------- Per-frame hands ----------------
       Called by the app each render frame. Converts the latest detection
       into smoothed, screen-space hand objects:
         { palm, tips:[5], span(px), pose }
       Positions are mirrored (selfie view) and carry their previous
       value so the fluid can derive a drag velocity. Returns [] when no
       hand is present. */
    update() {
      const W = this.view.w, H = this.view.h;
      if (!this.active || !W || !H) return EMPTY;

      const a = this.smoothing;
      const out = [];
      const present = new Set();
      const usedLabels = new Set();

      for (let hi = 0; hi < this.hands.length; hi++) {
        const lm = this.hands[hi].landmarks;
        // Stable-ish key per hand (handedness, de-duped if both report the same).
        let key = this.hands[hi].label;
        if (usedLabels.has(key)) key += hi;
        usedLabels.add(key);

        const smooth = (li, role) => {
          const sx = (1 - lm[li].x) * W;   // mirror X for a natural selfie feel
          const sy = lm[li].y * H;
          const tkey = key + ":" + role;
          const prev = this._tracks.get(tkey) || { x: sx, y: sy };
          const nx = prev.x + (sx - prev.x) * a;
          const ny = prev.y + (sy - prev.y) * a;
          this._tracks.set(tkey, { x: nx, y: ny });
          present.add(tkey);
          return { x: nx, y: ny, px: prev.x, py: prev.y };
        };

        const palm = smooth(PALM, "palm");
        const tips = [];
        for (const [li, spin] of FINGERTIPS) {
          const tip = smooth(li, "f" + li);
          tip.spin = spin;
          tips.push(tip);
        }
        // Hand size in screen px (wrist → middle fingertip) scales the gestures.
        const span = Math.hypot((1 - lm[WRIST].x) * W - (1 - lm[MIDDLE_TIP].x) * W,
                                lm[WRIST].y * H - lm[MIDDLE_TIP].y * H) || 120;

        out.push({ palm, tips, span, pose: this._classify(lm) });
      }

      // Forget tracks whose hand/finger vanished so they stop stirring.
      if (present.size !== this._tracks.size) {
        for (const k of this._tracks.keys()) if (!present.has(k)) this._tracks.delete(k);
      }

      this._reportGesture(out);
      return out;
    }

    // Update the preview caption to name the recognised gesture(s).
    _reportGesture(hands) {
      const NAMES = { open: "✋ Aura", fist: "✊ Vortex", pinch: "🤏 Spark", neutral: "✦ Stirring" };
      let key, text;
      if (hands.length === 0) {
        key = "none"; text = "Show your hand to the camera";
      } else if (hands.length === 2 && hands[0].pose === "open" && hands[1].pose === "open") {
        key = "bridge"; text = "✋✋ Energy bridge";
      } else {
        key = hands.map((h) => h.pose).join("+");
        text = hands.map((h) => NAMES[h.pose] || "✦").join("   ");
      }
      if (key === this._gestureKey) return;
      this._gestureKey = key;
      this._status(text);
    }
  }

  const EMPTY = [];

  Aether.HandTracker = HandTracker;
})((window.Aether = window.Aether || {}));
