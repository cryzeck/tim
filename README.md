# The Improbable Apparatus

A 3D chain-reaction puzzle game for the browser, in the tradition of the classic
contraption puzzlers. Build absurd machines on a workbench out of ramps, dominoes, fans,
seesaws, magnets, balloons, conveyor belts and pressure plates, then press **Run**.

**Play:** open `index.html` in any modern desktop or mobile browser. It loads three.js and
cannon-es from jsDelivr, so the first load needs a network connection.

- 12 puzzles with par scores and a hint system, plus an unlimited free workshop
- 25 gadgets, all simulated with real rigid-body physics at a fixed 240 Hz, so a machine
  behaves the same way every time you run it
- Wire gadgets to coloured pressure plates, raise parts into mid-air with Q/E, and switch
  to the front view (V) for the classic flat side-on look

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | The finished game: one self-contained file |
| `artifact.html` | The same page without the document skeleton, for hosting |
| `src/` | Sources: markup, styles and the game modules |
| `build.py` | Concatenates `src/` into the two HTML files |
| `tests/verify-levels.js` | Plays every puzzle's reference solution headlessly |

Source modules, in load order: `01_core` (constants, synthesised audio), `02_render`
(scene, procedural textures, materials, particles), `03_parts` (every gadget's model and
physics), `04_sim` (the deterministic physics world and goals), `05_levels` (puzzle data
and reference solutions) and `06_game` (building, UI, camera, main loop).

```bash
python3 build.py
```

```bash
node tests/verify-levels.js
```

The test opens the built game in headless Chromium. For every puzzle it checks that the
reference solution wins, still wins when starting positions are nudged, and that an empty
bench does not win.
