# skinslides-web

An interactive video installation. Video and audio analysis data are projected into a
shared 10-axis "texture" vector space, and the video shown next is chosen dynamically
from onomatopoeia words detected in the audio as it plays. The same soundtrack produces
a different combination of visuals every time it runs.

- Sound: Otomo Yoshihide
- Dance: Alessio Silvestrin
- System re-engineering & AI logic: Richi Owaki, AI Agent

## Running it locally

```bash
python server.py
```

Open `http://localhost:8000`. Video assets are excluded from this repository and are
streamed from Cloudflare R2 in production; place 360p copies under `videos/` if you want
to preview offline.

---

## System Architecture

The system is built from four layers:

```
Layer 1: Analysis data (52 video clips + 47 audio tracks)
   |
Layer 2: Projection into a 10-axis vector space
   |
Layer 3: Onomatopoeia dictionary + word triggers (during playback)
   |
Layer 4: Video-selection engine + live relationship map
```

### Layer 1 — Analysis data

**Video clips (52 clips, ~30s each)** each carry:

- `logic_weights.json` — hand-scored values (0–9): Weight, Time, Space, Hardness
- `Video analysis data/metadata_cv2.json` — OpenCV body analysis: average body
  velocity, contact area, limb separation, extension
- `Video analysis data/metadata.json` — pose-estimation analysis: center-of-mass
  movement, posture-change frequency, peak intensity, contact points
- `pauseTime.xml` — freeze-frame points (holds for Fibonacci seconds: 1, 1, 2, 3, 5)

**Audio tracks (47 tracks)** each carry, in `Audio analysis data/sound_metadata.json`:

- Trigger events (time, type, strength, and the **onomatopoeia word** tied to that moment)
- An acoustic profile (dynamic range, dominant frequency, ratio of attack vs. sustained texture)
- A 10-axis vector for the whole track (see below)

### Layer 2 — Projection into a 10-axis vector space

Each of the 52 video clips is projected into 10 axes by `tools/build_lexicon_map.js`:

| Axis | Formula | Meaning |
|---|---|---|
| x1: Weight | 0.6·hand-score + 0.4·(1−velocity)·9 | Perceived heaviness |
| x2: Time | 0.5·hand-score + 0.5·velocity·9 | Tempo / immediacy |
| x3: Space | 0.4·hand-score + 0.4·extension·9 + 0.2·limb-separation·9 | Spatial spread |
| x4: Flow | ((1−freeze-rate)·0.5 + com-movement·0.5)·9 | Smoothness of motion |
| x5: Hardness | 0.5·hand-score + 0.5·peak-intensity·9 | Hardness / impact |
| x6: Moisture | contact-area·9 | Softness / adhesion |
| x7: Frequency | 4.5 (fixed) | No pitch information in video, held neutral |
| x8: Decay | (freeze-rate·0.6 + peak-intensity·0.4)·9 | Tendency to settle into stillness |
| x9: Reynolds | (posture-change·0.6 + limb-separation·0.4)·9 | Turbulence / complexity |
| x16: Regularity | posture-change·9 | Repetitiveness |

Each axis is normalized to a 0–9 range relative to the other 51 clips, blending the
hand-scored (subjective) values with the analyzed (objective) ones. Audio tracks are
projected into the same space, but from different acoustic features (onset density,
dynamic range, dominant frequency), and their vectors are stored directly in
`sound_metadata.json`.

x7 (Frequency) carries no information for video, so it is excluded from any
video↔word or video↔audio distance calculation.

### Layer 3 — Onomatopoeia dictionary and live word triggers

The system keeps a dictionary of Japanese onomatopoeia
(`Audio analysis data/onomatopoeia_dictionary.csv`), each word carrying the same
10-axis vector. For example:

- *guigui* (ぐいぐい) — a forceful, pulling motion (high Hardness, continuous Flow)
- *chimachima* (ちまちま) — small and frequent (low Space, short Time)
- *ecchira-occhira* (えっちらおっちら) — clumsy, halting progress (low Flow, low Regularity)

Every audio track's `triggers.events` array records which onomatopoeia word is active
at each moment. During playback, the engine looks up the word active at the current
timestamp, and that word's 10-axis vector influences which video is selected next.

### Layer 4 — Video-selection engine (onomatopoeia-driven)

In "test-level2" (a scene where clips connect and flow through a pipe-like layout),
choosing the next clip works in four steps
(`pickNextPipe()` / `pipeApplyOnomaBias()`):

1. **Edge filter** — the pipe layout has four sides (a/b/c/d); only clips whose entry
   side matches the current clip's exit side are candidates. This filter is the
   **core rule and is never altered** — as a direct consequence, the b/d and d/b
   pairings occur disproportionately often, which is expected.
2. **Distance** — for the filtered candidates, compute the Euclidean distance
   (excluding x7) between each clip's 10-axis vector and the currently active
   trigger word's vector.
3. **Rank-relative weighting** — convert each candidate's rank within that distance
   ranking into a multiplier, bounded between `PIPE_ONOMA_BIAS` (1.8×, closest) and
   its reciprocal (≈0.56×, farthest). No candidate is ever excluded.
4. **Weighted random pick** — the next clip is drawn using that weighted
   probability distribution.

This keeps the pipe's connection rule completely untouched while layering a
"texture affinity" bias on top of it. A 600-step simulation showed zero connection
violations, all 52 clips used at least once, evenness improving from 0.953 to 0.963,
and word-affinity distance improving 3.6–8.6%.

**Play B** (a collage of six simultaneously-playing tiles, swapped by audio triggers)
enforces a minimum dwell time (6s normally, 1.2s for a "flash" subset) and refuses to
evict a tile that has not yet rendered a frame, which eliminated the earlier problem
of tiles disappearing before they were ever seen.

### Layer 5 — Live relationship map

`tools/lexicon_map_data.json` holds 181 nodes (52 clips + 82 words + 47 tracks), each
with its 10-axis vector, a 2D PCA projection for display, and edges to related nodes.
During playback, the selected clip and its trigger word light up on this map
(`lexicon_live.js`), visualizing the relationship that led to that choice.

---

## Worked example: clip 01 and track T522

### Clip 01 (`01-Sss720p.mp4`)

| | |
|---|---|
| Duration | 32.4s |
| Posture | standing |
| Direction | right → left |
| Freeze frames | none |

Hand-scored values: Weight 4, Time 3, Space 6, Hardness 6 (out of 9).

**Computed 10-axis vector**

| Axis | Value |
|---|---|
| Weight | 5.76 |
| Time | 1.80 |
| Space | 5.62 |
| Flow | 7.38 |
| Hardness | 7.50 |
| Moisture | 2.79 |
| Frequency | 4.50 (fixed) |
| Decay | 3.60 |
| Reynolds | 1.08 |
| Regularity | 1.80 |

Overall texture: forceful, quick, sharp — but structurally simple, not turbulent.

### Track T522 (`T522.aif`)

| | |
|---|---|
| Duration | 175.2s |
| Dynamism | 60.5 |
| Trigger density | 9.93/min (41 sustained, 19 attack) |

**Stored 10-axis vector**

| Axis | Value |
|---|---|
| Weight | 0.96 |
| Time | 4.83 |
| Space | 4.19 |
| Flow | 3.23 |
| Hardness | 4.77 |
| Moisture | 4.86 |
| Frequency | 4.90 |
| Decay | 2.46 |
| Reynolds | 3.50 |
| Regularity | 4.81 |

Overall texture: light, clean, and stable, with a clear pitch. Its texture is
dominated by sustained ticking rather than attacks, so it reads as rhythmic and
predictable.

### How they relate

10-axis Euclidean distance (x7 excluded):

| Comparison | Distance |
|---|---|
| Clip 01 ↔ T522's own timbre vector | 8.91 |
| Clip 01 ↔ T522's frequency-weighted average of its trigger words | 7.51 |

Going through the words brings the two closer together. Of the words that actually
occur in T522 — *guigui* ×8, *essa-essa* ×7, *charanporan* ×7, *gakkari* ×6,
*ryuーn* ×6, *iraira* ×6, *gamigami* ×5, *ecchira-occhira* ×4 — the one closest to
clip 01 is *ecchira-occhira* (distance 6.60). The word that occurs most often in
T522, *guigui*, is in fact the farthest from clip 01 (distance 9.98).

In other words: even while the same track T522 is playing, the moments tagged
*guigui* make clip 01 unlikely to be chosen, while the moments tagged
*ecchira-occhira* make it much more likely — producing variation over time from a
single audio source.

Across the full 82-word dictionary, the word closest to clip 01 overall is
*chimachima* (distance 5.29), which doesn't occur in T522 at all — a reminder that
this system works on probabilistic affinity, not exact matching.

---

## Summary

1. **Layered analysis** — hand-scored values (subjective), OpenCV data (objective),
   and pose estimation (detailed) are blended together.
2. **A shared 10-axis space** — video, audio, and words all live in the same space,
   giving a common notion of "distance" between them.
3. **The role of onomatopoeia** — not just a randomizer, but a deliberate mapping
   from the texture of the sound playing right now to the choice of what's shown.
4. **Rules stay intact** — the pipe's connection rules are fully preserved; the
   onomatopoeia bias is layered strictly on top of them.
5. **Live visualization** — the selection process itself, not just its output, is
   presented to the viewer through the relationship map.

---

## License

Music, visuals, and performance assets are **All Rights Reserved**. The program
code (system architecture and AI logic) is licensed under **CC BY 4.0**. See
[NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for details.

---

## Working notes (Japanese, for the author)

Implementation history, design rationale, and handoff notes between working
sessions are kept separately in Japanese: [`docs/work-log/`](docs/work-log/).
