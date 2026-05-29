/* ============================================================
   Aether Field — audio-engine.js
   ------------------------------------------------------------
   Owns the Web Audio graph and the three input sources:

     • Upload   — an <audio> element playing a local file
     • Mic      — getUserMedia({ audio })
     • System   — getDisplayMedia({ audio, video }) (tab/window/screen)

   A single shared AnalyserNode feeds the FeatureExtractor. Only the
   uploaded file is routed to the speakers; mic and system inputs are
   analysed but never sent to the output (avoids feedback / echo).

   No backend, no API keys — everything runs in the browser.
   ============================================================ */

(function (Aether) {
  "use strict";

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.analyser = null;      // pure analysis tap — NEVER connected to destination
      this.musicSource = null;   // MediaElementSourceNode (created once per element)
      this.musicConnected = false;
      this.micSource = null;
      this.systemSource = null;
      this.micStream = null;
      this.systemStream = null;
      this.activeInput = null;   // 'music' | 'mic' | 'system' | null
    }

    ensureContext() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;             // 1024 frequency bins
      this.analyser.smoothingTimeConstant = 0.8;
    }

    async resume() {
      this.ensureContext();
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (e) { /* ignore */ }
      }
    }

    // Disconnect whichever non-music input is currently feeding the analyser.
    _disconnectInput(kind) {
      if (kind === "mic" && this.micSource) {
        try { this.micSource.disconnect(); } catch (e) {}
        this.micSource = null;
      }
      if (kind === "system" && this.systemSource) {
        try { this.systemSource.disconnect(); } catch (e) {}
        this.systemSource = null;
      }
    }

    /* ---------------- Upload / <audio> element ----------------
       The music source taps the analyser AND drives the speakers
       directly. The analyser itself is never wired to destination,
       so mic / system inputs can be analysed without feeding back. */
    connectMusic(audioEl) {
      this.ensureContext();
      if (!this.musicSource) {
        // createMediaElementSource may only be called once per element.
        this.musicSource = this.ctx.createMediaElementSource(audioEl);
      }
      if (!this.musicConnected) {
        this.musicSource.connect(this.analyser);       // analysis tap
        this.musicSource.connect(this.ctx.destination); // audible output
        this.musicConnected = true;
      }
      this.activeInput = "music";
    }

    /* ---------------- Microphone ---------------- */
    async startMic() {
      this.ensureContext();
      await this.resume();
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.analyser); // analysed only — never to destination
      this.activeInput = "mic";
    }

    stopMic() {
      this._disconnectInput("mic");
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }
    }

    /* ---------------- System / tab audio ---------------- */
    async startSystem() {
      this.ensureContext();
      await this.resume();
      // video:true is required by most browsers for getDisplayMedia, but we
      // only want the audio. We grab the stream, keep the audio track, and
      // immediately stop the video track — that releases the screen capture so
      // the browser's "you're sharing your screen" banner / shared-region
      // border goes away while the audio keeps flowing.
      this.systemStream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
      });
      const audioTracks = this.systemStream.getAudioTracks();
      if (audioTracks.length === 0) {
        // User shared a surface without ticking "share audio".
        this.systemStream.getTracks().forEach((t) => t.stop());
        this.systemStream = null;
        throw new Error("no-audio-track");
      }
      // Stop the video track right away (audio-only capture).
      this.systemStream.getVideoTracks().forEach((t) => t.stop());

      // Build an audio-only stream for the analyser.
      const audioOnly = new MediaStream([audioTracks[0]]);
      this.systemSource = this.ctx.createMediaStreamSource(audioOnly);
      this.systemSource.connect(this.analyser); // analysed only — not to destination
      this.activeInput = "system";

      // If the user stops sharing from the browser UI, surface it.
      audioTracks[0].addEventListener("ended", () => {
        if (this.onSystemEnded) this.onSystemEnded();
      });
      return this.systemStream;
    }

    stopSystem() {
      this._disconnectInput("system");
      if (this.systemStream) {
        this.systemStream.getTracks().forEach((t) => t.stop());
        this.systemStream = null;
      }
    }

    // Stop every non-music input (used when switching modes).
    stopCapture() {
      this.stopMic();
      this.stopSystem();
    }
  }

  Aether.AudioEngine = AudioEngine;
})((window.Aether = window.Aether || {}));
