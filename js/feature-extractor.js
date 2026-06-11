/* ============================================================
   Aether Field — feature-extractor.js
   ------------------------------------------------------------
   Turns raw FFT / waveform data from a Web Audio AnalyserNode
   into the audio feature vector:

       A(t) = [rms, bass, lowMid, mid, highMid, treble, centroid, flux, onset]

   (plus sub-bass and a smoothed long-term energy used elsewhere).

   Key formulas
   ------------
   Long-term energy (exponential moving average):
       E_t = α·E_{t-1} + (1-α)·rms_t

   Adaptive normalization (per feature, so quiet and loud tracks
   both fill the visual range):
       x_norm = clamp((x - rollingMin) / (rollingMax - rollingMin + ε), 0, 1)

   Spectral centroid (the "brightness" of the sound):
       centroid = Σ(f_i · magnitude_i) / Σ(magnitude_i)

   Spectral flux (how fast the spectrum is changing):
       flux = Σ max(0, magnitude_i(t) - magnitude_i(t-1))

   Onset detection (adaptive threshold on flux):
       onset = flux > rollingFluxMean + thresholdMultiplier · rollingFluxStd
   ============================================================ */

(function (Aether) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // Adaptive min/max normalizer: expands instantly to new extremes,
  // contracts slowly so the visual range tracks the current section.
  class Normalizer {
    constructor(min = 0, max = 0.001) {
      this.min = min;
      this.max = max;
    }
    norm(x) {
      if (x > this.max) this.max = x;
      else this.max += (x - this.max) * 0.0008;
      if (x < this.min) this.min = x;
      else this.min += (x - this.min) * 0.0008;
      return clamp((x - this.min) / (this.max - this.min + 1e-5), 0, 1);
    }
  }

  // Frequency bands in Hz.
  const BANDS = {
    sub: [20, 60],
    bass: [60, 150],
    lowMid: [150, 400],
    mid: [400, 1200],
    highMid: [1200, 4000],
    treble: [4000, 16000],
  };

  class FeatureExtractor {
    constructor(analyser) {
      this.analyser = analyser;
      this.sampleRate = analyser.context.sampleRate;
      this.binCount = analyser.frequencyBinCount;     // = fftSize / 2
      this.nyquist = this.sampleRate / 2;
      this.hzPerBin = this.nyquist / this.binCount;

      this.freq = new Uint8Array(this.binCount);       // 0..255 magnitudes
      this.time = new Uint8Array(analyser.fftSize);    // waveform
      this.prevMag = new Float32Array(this.binCount);  // previous normalized spectrum (for flux)

      // Smoothed feature values (0..~1).
      this.features = {
        rms: 0, sub: 0, bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0,
        centroid: 0, flux: 0, onset: 0, onsetStrength: 0, energy: 0,
      };

      // Per-feature adaptive normalizers.
      this.norm = {
        rms: new Normalizer(), sub: new Normalizer(), bass: new Normalizer(),
        lowMid: new Normalizer(), mid: new Normalizer(), highMid: new Normalizer(),
        treble: new Normalizer(), flux: new Normalizer(),
      };

      // Onset / flux running statistics.
      this.fluxMean = 0;
      this.fluxVar = 0;
      this.lastOnset = 0;
      this.onsetCooldownMs = 110;
      this.thresholdMultiplier = 1.6;
      this._onsetEnv = 0;   // decaying beat envelope (so a kick lasts ~0.3s, not 1 frame)

      // Precompute the [startBin, endBin] index ranges for each band.
      this.bandBins = {};
      for (const k in BANDS) {
        const [lo, hi] = BANDS[k];
        this.bandBins[k] = [
          Math.max(0, Math.floor(lo / this.hzPerBin)),
          Math.min(this.binCount, Math.ceil(hi / this.hzPerBin)),
        ];
      }
    }

    _bandAverage(name) {
      const [s, e] = this.bandBins[name];
      let sum = 0;
      for (let i = s; i < e; i++) sum += this.freq[i];
      return e > s ? sum / (e - s) / 255 : 0;
    }

    // Frame-rate-aware smoothing helper.
    static _k(base, dt) { return 1 - Math.pow(base, dt); }

    // Decay all features toward zero when no audio is active (calm settling).
    idle(dt) {
      const k = FeatureExtractor._k(0.02, dt);
      const F = this.features;
      F.rms += (0 - F.rms) * k;
      F.sub += (0 - F.sub) * k;
      F.bass += (0 - F.bass) * k;
      F.lowMid += (0 - F.lowMid) * k;
      F.mid += (0 - F.mid) * k;
      F.highMid += (0 - F.highMid) * k;
      F.treble += (0 - F.treble) * k;
      F.flux += (0 - F.flux) * k;
      F.energy += (0 - F.energy) * k * 0.5;
      F.onset = 0;
      F.onsetStrength = 0;
      this._onsetEnv = 0;
      return F;
    }

    // Compute the feature vector for the current frame. dt in seconds.
    update(dt) {
      const an = this.analyser;
      an.getByteFrequencyData(this.freq);
      an.getByteTimeDomainData(this.time);

      // --- RMS from time-domain waveform ---
      let sumSq = 0;
      const td = this.time;
      for (let i = 0; i < td.length; i++) {
        const s = (td[i] - 128) / 128;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / td.length);

      // --- Raw band energies ---
      const sub = this._bandAverage("sub");
      const bass = this._bandAverage("bass");
      const lowMid = this._bandAverage("lowMid");
      const mid = this._bandAverage("mid");
      const highMid = this._bandAverage("highMid");
      const treble = this._bandAverage("treble");

      // --- Spectral centroid (Hz), normalized to 0..1 by a reference freq ---
      let wsum = 0, msum = 0;
      for (let i = 0; i < this.binCount; i++) {
        const m = this.freq[i];
        wsum += i * this.hzPerBin * m;
        msum += m;
      }
      const centroidHz = msum > 0 ? wsum / msum : 0;
      const centroid = clamp(centroidHz / 6000, 0, 1);

      // --- Spectral flux: positive change in normalized spectrum ---
      let flux = 0;
      const prev = this.prevMag;
      for (let i = 0; i < this.binCount; i++) {
        const m = this.freq[i] / 255;
        const d = m - prev[i];
        if (d > 0) flux += d;
        prev[i] = m;
      }
      flux /= this.binCount; // ~0..1

      // --- Onset detection: adaptive threshold on flux ---
      const beforeMean = this.fluxMean;
      this.fluxMean += (flux - this.fluxMean) * 0.05;
      this.fluxVar += ((flux - beforeMean) * (flux - beforeMean) - this.fluxVar) * 0.05;
      const fluxStd = Math.sqrt(Math.max(0, this.fluxVar));
      const now = performance.now();
      let onset = 0, onsetStrength = 0;
      if (
        flux > this.fluxMean + this.thresholdMultiplier * fluxStd &&
        flux > 0.004 &&
        now - this.lastOnset > this.onsetCooldownMs
      ) {
        onset = 1;
        onsetStrength = clamp((flux - this.fluxMean) / (fluxStd + 1e-4), 0, 4) / 4;
        this.lastOnset = now;
      }

      // --- Adaptive normalization + frame-rate-aware smoothing ---
      const F = this.features;
      const kFast = FeatureExtractor._k(0.0008, dt); // responsive features
      const kSlow = FeatureExtractor._k(0.05, dt);    // long-term energy

      F.rms += (this.norm.rms.norm(rms) - F.rms) * kFast;
      F.sub += (this.norm.sub.norm(sub) - F.sub) * kFast;
      F.bass += (this.norm.bass.norm(bass) - F.bass) * kFast;
      F.lowMid += (this.norm.lowMid.norm(lowMid) - F.lowMid) * kFast;
      F.mid += (this.norm.mid.norm(mid) - F.mid) * kFast;
      F.highMid += (this.norm.highMid.norm(highMid) - F.highMid) * kFast;
      F.treble += (this.norm.treble.norm(treble) - F.treble) * kFast;
      F.centroid += (centroid - F.centroid) * kFast;
      F.flux += (this.norm.flux.norm(flux) - F.flux) * kFast;

      // E_t = α·E_{t-1} + (1-α)·rms_t  (here via the smoothing helper)
      F.energy += (rms - F.energy) * kSlow;

      F.onset = onset;
      // The raw onset is a single-frame spike; the forces it drives
      // (waveAmpOnset, repelOnset) would act for ~16ms and be invisible.
      // Hold it in a short exponential envelope so each beat lands as a
      // readable punch in the fluid.
      this._onsetEnv = Math.max(this._onsetEnv * Math.exp(-dt * 6), onsetStrength);
      F.onsetStrength = this._onsetEnv;
      F.centroidHz = centroidHz;
      return F;
    }
  }

  Aether.FeatureExtractor = FeatureExtractor;
})((window.Aether = window.Aether || {}));
