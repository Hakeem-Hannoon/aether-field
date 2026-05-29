/* ============================================================
   Aether Field — ui-controller.js
   ------------------------------------------------------------
   Wires all DOM controls to the app and owns the keyboard
   shortcuts, fullscreen toggle, and hide/show panel behavior.

   The app passes a `handlers` object; the controller never touches
   audio or rendering directly — it only translates UI events into
   handler calls and reflects state back into the DOM.

   Keyboard shortcuts:
     F      fullscreen toggle
     H      hide / show control panel
     Space  play / pause uploaded audio
     M      microphone mode
     U      upload mode
     S      system / tab audio capture
   ============================================================ */

(function (Aether) {
  "use strict";

  class UIController {
    constructor(handlers) {
      this.h = handlers;
      const $ = (id) => document.getElementById(id);

      this.dom = {
        panel: $("panel"),
        restoreBtn: $("restoreBtn"),
        modeUpload: $("modeUpload"),
        modeMic: $("modeMic"),
        modeSystem: $("modeSystem"),
        musicControls: $("musicControls"),
        uploadBtn: $("uploadBtn"),
        fileInput: $("fileInput"),
        playBtn: $("playBtn"),
        playIcon: document.querySelector("#playBtn .ic-play"),
        prevBtn: $("prevBtn"),
        nextBtn: $("nextBtn"),
        seek: $("seek"),
        curTime: $("curTime"),
        durTime: $("durTime"),
        queue: $("queue"),
        trackName: $("trackName"),
        volumeRow: $("volumeRow"),
        volume: $("volume"),
        intensity: $("intensity"),
        densityBtns: document.querySelectorAll("[data-density]"),
        mergeBtns: document.querySelectorAll("[data-merge]"),
        fullscreenBtn: $("fullscreenBtn"),
        hideBtn: $("hideBtn"),
        systemNote: $("systemNote"),
        status: $("status"),
        statusDot: $("statusDot"),
      };

      this.mode = "upload";
      this._wire();
    }

    _wire() {
      const d = this.dom, h = this.h;

      d.modeUpload.addEventListener("click", () => this.setMode("upload"));
      d.modeMic.addEventListener("click", () => this.setMode("mic"));
      d.modeSystem.addEventListener("click", () => this.setMode("system"));

      d.uploadBtn.addEventListener("click", () => d.fileInput.click());
      d.fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files.length) h.onUploadFiles(e.target.files);
        e.target.value = ""; // allow re-selecting the same file(s)
      });
      d.playBtn.addEventListener("click", () => h.onTogglePlay());
      d.prevBtn.addEventListener("click", () => h.onPrev());
      d.nextBtn.addEventListener("click", () => h.onNext());

      // Seek bar: preview the time while dragging, commit on release.
      this.scrubbing = false;
      this.duration = 0;
      d.seek.addEventListener("input", () => {
        this.scrubbing = true;
        const frac = parseFloat(d.seek.value);
        this.dom.curTime.textContent = UIController._fmtTime(frac * this.duration);
        this._paintSeek(frac);
      });
      d.seek.addEventListener("change", () => {
        h.onSeek(parseFloat(d.seek.value));
        this.scrubbing = false;
      });

      d.volume.addEventListener("input", (e) => h.onVolume(parseFloat(e.target.value)));
      d.intensity.addEventListener("input", (e) => h.onIntensity(parseFloat(e.target.value)));

      d.densityBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          d.densityBtns.forEach((b) => b.classList.remove("is-active"));
          btn.classList.add("is-active");
          h.onDensity(btn.dataset.density);
        });
      });

      d.mergeBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          d.mergeBtns.forEach((b) => b.classList.remove("is-active"));
          btn.classList.add("is-active");
          h.onMergeToggle(btn.dataset.merge === "on");
        });
      });

      d.fullscreenBtn.addEventListener("click", () => this.toggleFullscreen());
      d.hideBtn.addEventListener("click", () => this.togglePanel(false));
      d.restoreBtn.addEventListener("click", () => this.togglePanel(true));

      document.addEventListener("keydown", (e) => this._onKey(e));
    }

    _onKey(e) {
      // Ignore shortcuts while typing in an input.
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      switch (e.key.toLowerCase()) {
        case "f": this.toggleFullscreen(); break;
        case "h": this.togglePanel(this.dom.panel.classList.contains("is-hidden")); break;
        case "m": this.setMode("mic"); break;
        case "u": this.setMode("upload"); break;
        case "s": this.setMode("system"); break;
        case "b": if (this.h.onTriggerMerge) this.h.onTriggerMerge(); break;
        case " ":
          if (this.mode === "upload") { e.preventDefault(); this.h.onTogglePlay(); }
          break;
      }
    }

    /* ---------------- Mode switching ---------------- */
    setMode(mode) {
      if (mode === this.mode) return;
      this.mode = mode;
      const d = this.dom;
      d.modeUpload.classList.toggle("is-active", mode === "upload");
      d.modeMic.classList.toggle("is-active", mode === "mic");
      d.modeSystem.classList.toggle("is-active", mode === "system");
      d.modeUpload.setAttribute("aria-selected", mode === "upload");
      d.modeMic.setAttribute("aria-selected", mode === "mic");
      d.modeSystem.setAttribute("aria-selected", mode === "system");

      // Upload-only controls.
      d.musicControls.style.display = mode === "upload" ? "" : "none";
      d.volumeRow.style.display = mode === "upload" ? "" : "none";
      // System-audio explanation.
      d.systemNote.style.display = mode === "system" ? "" : "none";

      this.h.onMode(mode);
    }

    /* ---------------- Fullscreen ---------------- */
    toggleFullscreen() {
      const el = document.documentElement;
      if (!document.fullscreenElement) {
        (el.requestFullscreen || el.webkitRequestFullscreen).call(el).catch(() => {
          this.setStatus("blocked", "Fullscreen blocked");
        });
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      }
    }

    /* ---------------- Hide / show panel ---------------- */
    togglePanel(show) {
      const hidden = !show;
      this.dom.panel.classList.toggle("is-hidden", hidden);
      this.dom.restoreBtn.classList.toggle("is-visible", hidden);
    }

    /* ---------------- State reflection (called by app) ---------------- */
    setStatus(kind, text) {
      this.dom.status.textContent = text;
      this.dom.statusDot.className =
        "status-dot" +
        (kind === "playing" ? " is-playing" :
         kind === "listening" ? " is-listening" :
         kind === "blocked" ? " is-blocked" : "");
    }

    setPlaying(playing) {
      if (this.dom.playIcon) this.dom.playIcon.textContent = playing ? "❚❚" : "▶";
    }

    setTrackName(name) { this.dom.trackName.textContent = name; }
    enablePlay(enabled) { this.dom.playBtn.disabled = !enabled; }

    // Enable/disable transport + seek depending on whether a queue exists.
    enableTransport(hasTracks, hasPrev, hasNext) {
      this.dom.playBtn.disabled = !hasTracks;
      this.dom.seek.disabled = !hasTracks;
      this.dom.prevBtn.disabled = !hasPrev;
      this.dom.nextBtn.disabled = !hasNext;
    }

    // Update the seek bar + time labels (called by app on timeupdate).
    setProgress(cur, dur) {
      const d = this.dom;
      this.duration = (isFinite(dur) && dur > 0) ? dur : 0;
      d.durTime.textContent = UIController._fmtTime(this.duration);
      if (this.scrubbing) return; // don't fight the user's drag
      const frac = this.duration ? Math.min(1, cur / this.duration) : 0;
      d.seek.value = String(frac);
      d.curTime.textContent = UIController._fmtTime(cur || 0);
      this._paintSeek(frac);
    }

    _paintSeek(frac) {
      const pct = (frac * 100).toFixed(1) + "%";
      this.dom.seek.style.background =
        `linear-gradient(90deg, var(--cyan) 0%, var(--violet) ${pct}, rgba(255,255,255,0.12) ${pct})`;
    }

    // Rebuild the queue list. items = [{name}], current = index (or -1).
    renderQueue(items, current) {
      const ul = this.dom.queue;
      ul.textContent = "";
      items.forEach((item, i) => {
        const li = document.createElement("li");
        if (i === current) li.classList.add("is-current");

        const idx = document.createElement("span");
        idx.className = "q-index";
        idx.textContent = String(i + 1);

        const name = document.createElement("span");
        name.className = "q-name";
        name.textContent = item.name;
        name.title = item.name;
        name.addEventListener("click", () => this.h.onSelectTrack(i));

        const rm = document.createElement("button");
        rm.className = "q-remove";
        rm.textContent = "×";
        rm.setAttribute("aria-label", "Remove from queue");
        rm.addEventListener("click", (e) => { e.stopPropagation(); this.h.onRemoveTrack(i); });

        li.append(idx, name, rm);
        ul.appendChild(li);
      });
    }

    static _fmtTime(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return m + ":" + (s < 10 ? "0" : "") + s;
    }
  }

  Aether.UIController = UIController;
})((window.Aether = window.Aether || {}));
