# Aether Field

A browser-based mathematical music visualizer where particles are advected through an audio-reactive fluid field.

This is motivated from the anmiations I used to stare at as a kid when I play music on my Windoes XP Media Player. Suggested song to play is this [remix of The Greatest](https://www.youtube.com/watch?v=yd8-nmLyYp0)

Website Link: [https://hakeem-hannoon.github.io/aether-field/](https://hakeem-hannoon.github.io/aether-field/)

---

## 1. Project overview

Aether Field turns live audio into motion. Instead of pushing dots around with random forces, it runs a small **2D incompressible fluid simulation** across the screen and lets thousands of particles ride that flow as passive **tracers**.

The pipeline each frame is:

1. **Listen** — audio comes from an uploaded file, the microphone, or captured tab/system audio.
2. **Analyze** — the signal is reduced to a compact feature vector `A(t) = [rms, bass, lowMid, mid, highMid, treble, centroid, flux, onset]` (plus sub-bass and a smoothed energy).
3. **Inject** — those features drive an equation for **two fixed, invisible "speakers"** that radiate pressure waves into the fluid (amplitude, pitch, speed, and harshness all set by the music), plus smooth global breathing and drift.
4. **Simulate** — the field is advanced with a Stable-Fluids solver (advect → diffuse → project) so it stays approximately divergence-free and forms real currents, eddies, and vortex filaments.
5. **Render** — particles sample the local velocity and follow it; their color is the local fluid "temperature" (speed + vorticity + audio). A low-resolution plasma glow of the field is drawn underneath.

The result feels like particles suspended in an invisible, music-driven fluid: calm drift during quiet passages, turbulent swirling chaos during intense ones.

It is a **static site** — no backend, no database, no API keys.

---

## 2. Feature list

- **Audio upload mode** — analyze and play local audio files; **queue several at once**, with a **seek/time bar**, previous/next, and auto-advance (cleanest analysis).
- **Microphone mode** — react to voice or anything your mic hears.
- **System / tab audio capture mode** — analyze a shared tab, window, or screen.
- **Fullscreen mode** — immersive edge-to-edge canvas.
- **Hide / show UI panel** — get the controls out of the way.
- **Particle density control** — Low / Med / High / Ultra / Max.
- **Visual intensity control** — scales how hard audio drives the fluid.
- **Keyboard shortcuts** — `F`, `H`, `Space`, `M`, `U`, `S`.
- **Mouse / touch field interaction** — drag to stir the fluid; press for a pressure burst.
- **Fluid-field particle motion** — particles are tracers of a real velocity field, not independent dots.
- **Smooth spectral color gradients** — a temperature model mapped through a 9-stop palette.
- **Speaker bonding animation** — every 5–10 minutes the two speakers spiral together into a colored swirl for 7 seconds, then separate (can be turned off).
- **Static deployment** — drop the folder on any static host.

---

## 3. File structure

Aether Field uses small, single-responsibility JavaScript modules (loaded as plain
`<script>` tags so the page also opens directly from `file://`).

```
index.html                  Markup, control panel, and module <script> tags
styles.css                  Visual styling (glass panel, background, controls)
README.md                   This document
js/
  color-mapper.js           Temperature → color LUT and the 9 color stops
  fluid-field.js            The Stable-Fluids solver (the mathematical core)
  feature-extractor.js      FFT/waveform → audio feature vector A(t)
  audio-engine.js           Web Audio graph: upload / mic / system sources
  particle-system.js        Particle tracers: advection, coloring, rendering
  ui-controller.js          DOM wiring, keyboard shortcuts, fullscreen, panel
  app.js                    Orchestration, sizing, render loop, field glow
```

**Module responsibilities**

| File | Responsibility |
|------|----------------|
| `color-mapper.js` | Builds a 256-entry RGB lookup table from the color stops; exposes `temperature()` and `colorAt()`. |
| `fluid-field.js` | `FluidField` class: grid storage, `addForce`, `addDye`, `step`, `advectVelocity`, `diffuseVelocity`, `computeDivergence`, `solvePressure`, `subtractPressureGradient`, `project`, `sampleVelocity`, `sampleVorticity`, `injectAudioForces`, `injectPointerForces`. |
| `feature-extractor.js` | `FeatureExtractor` class: band energies, RMS, spectral centroid, spectral flux, adaptive onset detection, adaptive normalization, smoothing. |
| `audio-engine.js` | `AudioEngine` class: a single `AnalyserNode` tap plus upload / mic / `getDisplayMedia` sources. |
| `particle-system.js` | `ParticleSystem` class: pre-baked glow sprites, fluid-following update, temperature coloring, additive rendering. |
| `ui-controller.js` | `UIController` class: translates UI events into handler calls; reflects status back into the DOM. |
| `app.js` | Wires everything together, owns the `requestAnimationFrame` loop and the low-res field-glow layer. |

---

## 4. How to run locally

**Option A — open directly.** Double-click `index.html`. The fluid + particles run immediately. (Microphone and system-audio capture may be blocked from `file://` in some browsers — see Option B.)

**Option B — run a tiny static server** (recommended; required for mic / system audio in most browsers, which only grant capture on a *secure context* such as `localhost`):

```bash
python3 -m http.server 8080
```

Then open:

```
http://localhost:8080
```

Any equivalent static server works (`npx serve`, `php -S localhost:8080`, etc.).

---

## 5. How to deploy

Aether Field is a pure static site, so deployment is just "upload the folder." **No backend is required.**

- **GitHub Pages** — push to a repo, then Settings → Pages → deploy from the branch root. Visit `https://<user>.github.io/<repo>/`.
- **Netlify** — drag-and-drop the folder onto the Netlify dashboard, or connect the repo (no build command, publish directory = project root).
- **Vercel** — `vercel` in the project root, or import the repo (Framework preset: *Other*, no build step).
- **Cloudflare Pages** — connect the repo with an empty build command and the project root as the output directory.
- **Any static host** — S3 + CloudFront, Surge, GitLab Pages, a plain Nginx/Apache directory, etc.

Keep the `js/` folder next to `index.html`; the script paths are relative.

---

## 6. Audio source modes

**Upload mode**
- Plays local audio files you choose. Usually the cleanest analysis because the signal is pristine and audible through the page.
- **Multiple files / queue:** "Add audio" accepts several files at once and appends them to a playlist. Click any track to jump to it, remove tracks with ×, and use ⏮ / ⏭ to move through the queue. When a track ends, the next one plays automatically.
- **Seek bar:** scrub through the current track; the labels show elapsed / total time.
- Controls: Add audio, Previous / Play-Pause / Next, Seek, Volume (defaults to 0.25).

**Microphone mode**
- Requests microphone permission via `getUserMedia`.
- Reacts to your voice, an instrument, or external speakers in the room.
- The mic is **analyzed but never routed to the speakers** (no feedback).

**System audio mode** *(optional / advanced)*
- Uses screen/tab capture via `getDisplayMedia({ audio: true, video: true })`.
- Requires you to choose a **tab, window, or screen** and enable **"Share audio"** in the browser dialog.
- The video track is **stopped immediately** — only the audio is kept — which drops the shared-screen preview/border. The browser will **still show a small "sharing" indicator** while it captures audio: that is **browser-enforced and cannot be removed by a web page** (it's a privacy guarantee — no site can capture your audio silently). Nothing is uploaded or recorded; the page only analyzes the sound, and you can stop sharing anytime.
- The audio is analyzed only (not re-played), so there is no echo.
- Browser support varies (best on recent desktop Chromium browsers; "share tab audio" is the most widely supported case).
- **No banner wanted?** Use **Upload** (your own files) or **Microphone** mode — neither shows any sharing indicator.

---

## 7. Browser permissions and limitations

- Websites **cannot silently capture all system audio**. Capture always requires an explicit user gesture and permission.
- System audio capture requires choosing a surface and ticking **"Share audio."** If you forget the checkbox, no audio track is produced and the app will tell you.
- While system audio is captured, the **browser shows a "sharing" indicator that a web page cannot hide, restyle, or remove** — it's a deliberate security guarantee. The only ways to avoid it are Upload mode, Microphone mode, or routing system output through a virtual loopback device (e.g. BlackHole / VB-Cable) and selecting that as the microphone.
- **Some browsers do not support system audio capture** at all (and mobile support is limited or absent).
- **Mobile support is limited** in general: autoplay restrictions, no system capture, and reduced particle counts.
- **YouTube / Spotify embeds generally cannot be analyzed directly** due to cross-origin and DRM restrictions. To visualize them, use **System audio mode** and share that tab, or play through your speakers and use **Microphone mode**.
- **Upload and microphone modes are the most reliable** across browsers.

---

## 8. Mathematical model

### 8.1 Governing equations

The field obeys the incompressible Navier–Stokes equations:

```
∂u/∂t + (u · ∇)u = -∇p / ρ + ν∇²u + f      (momentum)
∇ · u = 0                                   (incompressibility)
```

| Term | Meaning |
|------|---------|
| `u` | velocity field (2D vector per grid cell) |
| `(u · ∇)u` | **advection** — the fluid carries its own velocity along with it |
| `-∇p / ρ` | **pressure** gradient — enforces incompressibility (`ρ` is folded into `p`) |
| `ν∇²u` | **viscosity / diffusion** — smooths the velocity field |
| `f` | **external force** — the two audio "speakers", pointer interaction, procedural turbulence, vorticity confinement |
| `∇ · u = 0` | **incompressibility** — the flow neither creates nor destroys volume |

### 8.2 Stable-Fluids pipeline (Jos Stam, 1999)

Each frame, `FluidField.step(dt, A, pointer)` runs:

1. **Add forces** — `injectAudioForces`, `injectPointerForces`, procedural turbulence, and vorticity confinement add to `u`.
2. **Advect velocity** — semi-Lagrangian back-tracing (unconditionally stable): each cell looks "upstream" along `-u·dt`, then bilinearly samples the previous field.
3. **Diffuse velocity** — viscosity `ν∇²u` via Gauss–Seidel relaxation.
4. **Project velocity** — remove divergence so `∇ · u ≈ 0` (see 8.3).
5. **Advect particles** — handled in `particle-system.js` via `fluid.sampleVelocity` (see §11).

The grid is low-resolution for speed; particles render at full screen resolution.

### 8.3 Divergence-free projection

Incompressibility is approximated by removing divergence from the velocity field.

**Divergence:**
```
div(u) = ∂u_x/∂x + ∂u_y/∂y
```

**Pressure (relaxation of ∇²p = div):**
```
p_new = (p_left + p_right + p_bottom + p_top − divergence) / 4
```
This is the standard Jacobi relaxation formula. It is applied **in place
(Gauss–Seidel)** so each sweep reads already-updated neighbors and converges
much faster — a modest `PRESSURE_ITERATIONS` count (default **22**, tunable
12–28) is then enough to make the motion look genuinely fluid. In practice this
roughly halves the field's relative divergence each frame, which is the normal
operating point for real-time stable-fluids solvers.

**Subtract the pressure gradient:**
```
u = u − ∇p
```
After this step the velocity field is approximately divergence-free, which is what makes the motion read as a *fluid* rather than as expanding/collapsing dots.

---

## 9. Audio feature extraction

The analyser uses an FFT of size **2048** (1024 frequency bins). From it, `FeatureExtractor` computes the feature vector:

```
A(t) = [rms, bass, lowMid, mid, highMid, treble, centroid, flux, onset]
```

(plus `sub` for sub-bass and `energy`, a slow-moving level).

| Feature | Meaning |
|---------|---------|
| `rms`      | overall loudness (time-domain root-mean-square) |
| `sub`      | sub-bass band energy (≈ 20–60 Hz) |
| `bass`     | bass band energy (≈ 60–150 Hz) |
| `lowMid`   | low-mid band energy (≈ 150–400 Hz) |
| `mid`      | mid band energy (≈ 400–1200 Hz) |
| `highMid`  | high-mid band energy (≈ 1.2–4 kHz) |
| `treble`   | treble band energy (≈ 4–16 kHz) |
| `centroid` | spectral centroid (brightness), normalized 0–1 |
| `flux`     | spectral flux (rate of spectral change) |
| `onset`    | adaptive transient/beat flag (0 or 1) |

**Key formulas**

Long-term energy (exponential moving average):
```
E_t = α · E_{t-1} + (1 − α) · rms_t
```

Adaptive normalization, applied per feature so quiet and loud tracks both fill the visual range:
```
x_norm = clamp((x − rollingMin) / (rollingMax − rollingMin + ε), 0, 1)
```
(`rollingMax`/`rollingMin` expand instantly to new extremes and contract slowly.)

Spectral centroid (Hz, then normalized by a 6 kHz reference):
```
centroid = Σ(f_i · magnitude_i) / Σ(magnitude_i)
```

Spectral flux (positive change of the normalized spectrum):
```
flux = Σ max(0, magnitude_i(t) − magnitude_i(t−1))
```

Onset detection (adaptive threshold on flux, default multiplier 1.6, with a short cooldown):
```
onset = flux > rollingFluxMean + thresholdMultiplier · rollingFluxStd
```

All features are smoothed with frame-rate-aware factors so the visuals stay fluid regardless of frame rate.

---

## 10. Audio-to-fluid mapping

Audio features **do not move particles directly**. The core of the coupling is **two fixed, invisible circular "speakers"** placed left and right of center, like a stereo pair. Each radiates a traveling pressure wave *into the liquid*; a single equation decides how that wave looks, so there is nothing random popping up on screen.

**The speaker wave equation** (per speaker at radial distance `r`, time `t`, phase `φ`):

```
w(r,t) = A · [ sin(k·r − ω·t + φ) + H·0.5·sin(2.7k·r − 1.7ω·t + φ) ] · (1 − (r/R)²)²
```

with the four controls driven by the music:

| Symbol | Meaning | Driven by |
|--------|---------|-----------|
| `A` | **amplitude** — how intense / tall the waves are | `ampBase + rms·ampRms + bass·ampBass + onset·ampOnset` |
| `k = 2π/λ` | **pitch** — ring spacing (`λ` = wavelength) | `λ = mix(λLarge, λSmall, centroid)` → bright music = tight ripples, warm music = big slow swells |
| `ω` | **wave speed** — how fast rings travel outward | `omegaBase + energy·omegaGain` |
| `H` | **harshness** — adds a rough higher overtone | `clamp(highMid + treble + flux, 0, 1)` → rock / screaming churns; calm / romantic stays a smooth swell |

The second sine is an **overtone** that only switches on with harshness `H`, so aggressive, bright, transient-heavy music gets a gritty, rough wave texture while calm music is a pure, smooth swell. The two speakers run **π out of phase**, so their wavefronts interfere in the middle — the characteristic pattern of two sound sources in a fluid. The waves are injected as a *radial body force*, so the projection step turns them into genuine outward-propagating rings (not drawn-on circles).

A few smooth, non-random global motions sit underneath the speakers:

| Band | Effect on the fluid |
|------|---------------------|
| **Sub-bass** | slow global "breathing" pressure — a gentle radial in/out over the whole field |
| **Low-mid** | smooth, slowly-rotating directional drift current |
| **Mid / Flux** | raise **vorticity confinement**, so swirls and eddies stay crisp (`vorticityStrength = baseVorticity + mid·midGain + flux·fluxGain`) |
| **High-mid** | amplifies the ambient procedural curl-noise (shear / turbulence) |
| **Centroid** | sets the wave **pitch** (above) and the fluid **viscosity** (`viscosity = mix(highViscosity, lowViscosity, energyNorm)`) |
| **RMS / Treble** | inject **dye** glow at each speaker (`dyeInjection = rms·dyeGain + treble·sparkleGain`) so you can sense where the speakers sit |

On top of the oscillating waves, each speaker also **repels** the fluid (and therefore the particles) with a steady outward push. Its **strength** rises with loudness (`repel = rms·repelRms + bass·repelBass + onset·repelOnset`) and its **reach** is set by pitch (`repelRadius = mix(broad, tight, centroid)` — warm/low sounds shove particles away over a wide area, bright/high sounds clear only a tight zone). The result is a low-density "bubble" around each speaker that breathes and pushes outward with the music.

A pointer-controlled local vortex is a third, user-driven source you can stir in by dragging. All of the symbols above are tunable in `FluidField.config` (see the Customization guide).

### Speaker bonding animation

Every **5–10 minutes** (random) the two speakers play out a short choreography, and you can trigger it on demand with the **`B`** key:

1. **Approach (≈8 s)** — they spiral toward the shared center of mass, rotating around it and accelerating as they get closer (an orbital-decay feel), `rho → 0`.
2. **Merged (exactly 7 s)** — combined at the center, they spin fastest and emit a colored multi-arm swirl (the "bloom"). The varied velocity/vorticity across the arms spans the palette, so it reads as a rotating multi-colored flower. It is deliberately kept dim.
3. **Separate (≈8 s)** — they spiral back out and settle to their normal left/right rest positions (the rotation completes a whole number of turns, so they end perfectly horizontal).

The whole thing is driven by a state machine in `FluidField.updateBond()`. Speaker positions are `center ± rho·(cos φ, sin φ)` with `rho` (separation) and `φ` (rotation) animated by smootherstep curves. Turn it off with the **Merge animation: Off** control; while merged, the normal audio waves are eased down so the bloom stays the focus.

---

## 11. Particle advection

Particles are **tracers** of the velocity field:

```
dx/dt = u(x, t)

particle.velocity  = sampleVelocityField(particle.position)
particle.position += particle.velocity · dt
```

In code, particles keep a little inertial lag so trails curl smoothly, but the fluid is the dominant driver:

```
u = fluid.sampleVelocity(particle.x, particle.y)        // bilinear
particle.vx = lerp(particle.vx, u.x, fluidFollowStrength)
particle.vy = lerp(particle.vy, u.y, fluidFollowStrength)
particle.x += particle.vx · dt
particle.y += particle.vy · dt
```

**Bilinear interpolation.** Velocity is stored on a coarse grid, but particles live at continuous pixel positions. To sample, we find the four grid cells surrounding the particle and blend them by distance:

```
u(x, y) = (1−s)(1−t)·u00 + s(1−t)·u10 + (1−s)t·u01 + s·t·u11
```

where `s`, `t` are the fractional offsets within the cell. This gives a smooth, continuous velocity everywhere instead of blocky per-cell jumps.

**Why tracers instead of bouncing dots?** Independent particles with random forces look like noise. Tracers expose the *structure* of the flow — you literally see the streamlines, eddies, and vortices of the simulated fluid, which is what makes the motion feel physical and coherent.

---

## 12. Color system

Each particle's hue is the local fluid **temperature**:

```
T = clamp(a·|u| + b·|ω| + c·treble + d·flux + e·centroid, 0, 1)
```

with normalized velocity magnitude `|u|`, normalized vorticity `|ω|`, and the audio features. Defaults: `a = 0.5`, `b = 0.25`, `c = 0.32`, `d = 0.2`, `e = 0.2`. Velocity and vorticity vary across the field, so they lead; the audio terms (`c`, `d`, `e`) are the *same everywhere*, so they are kept small — otherwise loud music shifts the entire field to one uniform hot color. Particle **depth** and the **dye field** modulate brightness/size (not hue), which produces the plasma-like glow and parallax.

**Avoiding white-out.** Because particles and the field glow are drawn with additive (`lighter`) blending, brightness can pile up to pure white when the music is loud. Three things keep it under control: the velocity reference `velRef` is set high (so only the fastest streaks read as "hot/bright", not the whole field), particle alpha carries **no global loudness term** and is hard-capped, and the field-glow layer is **tone-mapped** (`a = 1 − e^(−x)`) so it rolls off smoothly instead of clipping. The master `CONFIG.brightness` dial scales it all.

`T` is mapped through these color stops:

```
0.00  deep blue
0.12  violet
0.25  electric blue
0.38  cyan
0.50  green
0.62  pink
0.74  orange
0.86  red
1.00  white-gold
```

The stops are baked once into a 256-entry lookup table with **smoothstep** interpolation between neighbors, so the gradient is continuous and the color of a particle reflects the visible energy of the fluid around it. Colors are never randomly reassigned frame-to-frame — a slow, cool current stays blue; a fast, spinning, treble-rich region glows toward white-gold.

---

## 13. Vorticity

Vorticity is the local spin of the fluid. In 2D it is the scalar curl:

```
ω = ∂u_y/∂x − ∂u_x/∂y
```

Left alone, numerical diffusion smears small vortices away. **Vorticity confinement** re-injects energy back into spinning regions so eddies and vortex filaments stay crisp:

```
N = normalize(∇|ω|)
f_vorticity = ε · (N × ω)
```

In 2D this is a force perpendicular to the gradient of `|ω|`, scaled by the local spin — it strengthens existing swirls instead of damping them.

Music increases the swirl:

- **Bass / RMS / onsets** raise the speaker **amplitude**, so the radial waves are taller and shed bigger rolling vortices.
- **Mid** raises the **vorticity confinement**, keeping rotational, ribbon-like flow crisp.
- **High-mid** amplifies the ambient curl-noise (fine shear and turbulence).
- **Treble / flux** raise the wave **harshness** `H`, adding the rough overtone that churns the field for aggressive music.

The confinement strength itself scales with the music: `vorticityStrength = baseVorticity + mid·midGain + flux·fluxGain`.

---

## 14. Controls and keyboard shortcuts

**Panel controls**

| Control | What it does |
|---------|--------------|
| Upload / Mic / System | choose the audio source |
| Add audio | open a file picker — select one or several files to queue (Upload mode) |
| ⏮ / ⏭ | previous / next track in the queue (⏮ restarts if past 3 s) |
| Play / Pause | play or pause the current track |
| Seek bar | scrub through the current track; shows elapsed / total time |
| Queue list | click a track to play it; × removes it |
| Volume | output volume of the current track (default 0.25) |
| Visual intensity | scales how hard audio drives the fluid (0–0.5) |
| Particle density | Low / Med / High / Ultra / Max particle count |
| Merge animation | turn the periodic speaker-bonding animation On / Off |
| ⤢ (fullscreen) | toggle fullscreen |
| × (hide) | hide the panel; a "Show panel" button appears |

**Mouse / touch**

- **Drag** on the field to stir the fluid (a local vortex follows the cursor).
- **Press / click** for a radial pressure burst and a dye splash.

**Keyboard shortcuts**

| Key | Action |
|-----|--------|
| `F` | toggle fullscreen |
| `H` | hide / show the control panel |
| `Space` | play / pause uploaded audio (Upload mode) |
| `M` | switch to microphone mode |
| `U` | switch to upload mode |
| `S` | start system / tab audio capture |
| `B` | trigger the speaker bonding animation now |

---

## 15. Customization guide

Most tuning lives in clearly-labeled config objects.

| What to tune | Where |
|--------------|-------|
| **Grid resolution** | `CONFIG.targetGridW` in `js/app.js` (desktop 132, mobile 84; the cell `scale` is derived from it) |
| **Particle count** | `CONFIG.density` and `CONFIG.maxParticles` in `js/app.js` |
| **Pressure iterations** | `config.pressureIterations` in `js/fluid-field.js` (12–28) |
| **Viscosity** | `config.viscLow` / `config.viscHigh` in `js/fluid-field.js` |
| **Vorticity strength** | `config.vorticity`, `config.midVortGain`, `config.fluxVortGain` in `js/fluid-field.js` |
| **Speaker waves** | the `wave*` / `speaker*` values in `FluidField.config` (amplitude, wavelength/pitch, speed, radius, separation) |
| **Bonding animation** | `this.bond` in `js/fluid-field.js` — `minGap`/`maxGap` (5–10 min window), `approach`/`merged`/`separate` durations, `turns`; and the `merge*` gains in `config` |
| **Other force strengths** | the remaining `*Gain` values in `FluidField.config` (sub-bass breathing, low-mid drift, dye, pointer, …) |
| **Color stops** | `COLOR_STOPS` in `js/color-mapper.js` |
| **Temperature coefficients** | `config.coeff` in `js/particle-system.js` |
| **Brightness** | `CONFIG.brightness` (master) and `CONFIG.velRef` in `js/app.js`; the particle `alpha` cap in `js/particle-system.js` |
| **Intensity defaults** | the `intensity` slider default in `index.html`; `state.intensity` in `js/app.js` |
| **Background gradients** | the `.bg-*` rules in `styles.css` and `CONFIG.bg` (trail color) in `js/app.js` |
| **Trail length / glow** | `CONFIG.trailFade` and `CONFIG.fieldGlowAlpha` in `js/app.js` |
| **UI text** | `index.html` |
| **Keyboard shortcuts** | `_onKey()` in `js/ui-controller.js` |

---

## 16. Performance notes

- The **fluid simulation runs on a low-resolution grid** (≈132 cells wide on desktop, ≈84 on mobile) — the expensive Navier–Stokes work is cheap because the grid is small.
- **Particles are rendered at full screen resolution** as additive glow sprites; the fluid plasma is drawn from a tiny offscreen canvas scaled up (the browser's bilinear upscaling smooths it for free).
- **Device pixel ratio is capped** (2 on desktop, 1.5 on mobile) so high-DPI screens don't quadruple the fill cost.
- **Particle counts are reduced on mobile** (lower density and a lower hard cap).
- **All simulation buffers are typed `Float32Array`s allocated once** (on construct/resize) and reused — `step()` never allocates large arrays.
- **Canvas 2D** is used throughout for broad compatibility (no WebGL required).
- The render loop is frame-rate independent: `dt` is measured and clamped, and all smoothing/force terms scale with it.

---

## 17. Troubleshooting

| Symptom | Likely cause & fix |
|---------|--------------------|
| **Microphone blocked** | Permission denied or page not on a secure context. Allow the mic and serve over `http://localhost` (Option B) or HTTPS. |
| **System audio not available** | Your browser doesn't support `getDisplayMedia` audio, or you didn't tick **"Share audio."** Try a recent desktop Chromium browser and share a **tab**. |
| **No audio detected / flat visuals** | Nothing is actually playing into the chosen source. In Upload mode press Play; in Mic mode raise input volume; in System mode confirm the shared surface is producing sound. |
| **Upload format unsupported** | Use a browser-supported format (MP3, WAV, OGG, M4A/AAC). |
| **Low frame rate** | Lower **Particle density**, reduce `CONFIG.targetGridW`, or lower `pressureIterations`. |
| **Fullscreen blocked** | Some browsers require a direct user gesture; click ⤢ instead of using the shortcut, and check site permissions. |
| **Browser permission problems** | Reset site permissions for mic/screen capture, reload, and serve over a secure context. |

---

## 18. Credits and license

Built by Hakeem Hanoun.

**License:** MIT license
