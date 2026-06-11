/* ============================================================
   Aether Field — color-mapper.js
   ------------------------------------------------------------
   Maps a scalar "temperature" T ∈ [0, 1] (the visible energy of
   the fluid) onto a smooth physical-looking color gradient.

   Temperature model used by the particle system:

       T = clamp(a*|u| + b*|ω| + c*treble + d*flux + e*centroid, 0, 1)

   where |u| is local velocity magnitude, |ω| is local vorticity,
   and treble / flux / centroid are normalized audio features.

   The gradient runs cold -> hot using the color stops:

       0.00  deep blue
       0.12  violet
       0.25  electric blue
       0.38  cyan
       0.50  spring green
       0.62  gold
       0.74  orange
       0.86  hot pink
       1.00  white-gold

   Adjacent stops are deliberately hue-neighbors: linear RGB blending
   between near-complementary colors (e.g. green -> pink) passes
   through a desaturated gray that reads as mud on screen.

   Colors are pre-baked into a 256-entry lookup table (LUT) once,
   then sampled per particle per frame — no per-frame color math,
   so hues never flicker randomly. Interpolation between stops is
   smoothstepped for a soft, continuous transition.
   ============================================================ */

(function (Aether) {
  "use strict";

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (t) => t * t * (3 - 2 * t);

  // [position 0..1, [r, g, b]]
  const COLOR_STOPS = [
    [0.00, [12, 28, 110]],   // deep blue
    [0.12, [92, 40, 214]],   // violet
    [0.25, [40, 120, 255]],  // electric blue
    [0.38, [38, 222, 255]],  // cyan
    [0.50, [54, 238, 150]],  // spring green
    [0.62, [252, 222, 90]],  // gold
    [0.74, [255, 150, 54]],  // orange
    [0.86, [255, 70, 130]],  // hot pink
    [1.00, [255, 240, 205]], // white-gold
  ];

  class ColorMapper {
    constructor(lutSize = 256) {
      this.lutSize = lutSize;
      // Flat RGB lookup table: lut[i*3 + {0,1,2}] = r,g,b.
      this.lut = new Uint8ClampedArray(lutSize * 3);
      this._buildLUT();
    }

    _buildLUT() {
      const n = this.lutSize;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const [r, g, b] = this._interpolate(t);
        this.lut[i * 3] = r;
        this.lut[i * 3 + 1] = g;
        this.lut[i * 3 + 2] = b;
      }
    }

    // Smoothly interpolate the raw color stops at position t ∈ [0, 1].
    _interpolate(t) {
      t = clamp(t, 0, 1);
      const stops = COLOR_STOPS;
      for (let i = 0; i < stops.length - 1; i++) {
        const [p0, c0] = stops[i];
        const [p1, c1] = stops[i + 1];
        if (t <= p1) {
          const f = smoothstep((t - p0) / (p1 - p0 || 1));
          return [
            c0[0] + (c1[0] - c0[0]) * f,
            c0[1] + (c1[1] - c0[1]) * f,
            c0[2] + (c1[2] - c0[2]) * f,
          ];
        }
      }
      return stops[stops.length - 1][1].slice();
    }

    // Temperature equation. All inputs are expected pre-normalized 0..1.
    //   T = clamp(a*velN + b*vortN + c*treble + d*flux + e*centroid, 0, 1)
    temperature(velN, vortN, treble, flux, centroid, coeff) {
      const a = coeff.a, b = coeff.b, c = coeff.c, d = coeff.d, e = coeff.e;
      return clamp(
        a * velN + b * vortN + c * treble + d * flux + e * centroid,
        0,
        1
      );
    }

    // Returns the LUT index for a temperature (used to pick a glow sprite).
    indexFor(t) {
      return (clamp(t, 0, 0.99999) * (this.lutSize - 1)) | 0;
    }

    // Returns [r, g, b] for a temperature value.
    colorAt(t) {
      const i = this.indexFor(t) * 3;
      return [this.lut[i], this.lut[i + 1], this.lut[i + 2]];
    }
  }

  Aether.ColorMapper = ColorMapper;
  Aether.COLOR_STOPS = COLOR_STOPS;
})((window.Aether = window.Aether || {}));
