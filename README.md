# Det Utrolige Apparatet

A 3D chain-reaction puzzle game for the browser, in the tradition of the classic
contraption puzzlers. Build absurd machines on a workbench out of ramps, dominoes, fans,
seesaws, magnets, balloons, conveyor belts and pressure plates, then press **Start**.
The game text is in Norwegian (bokmål) and written for children from about 8 years old.

**Play:** open `index.html` in any modern desktop or tablet browser. It loads three.js and
cannon-es from jsDelivr, so the first load needs a network connection.

- 12 puzzles with par scores and a hint system, plus an unlimited free workshop
- 25 gadgets, all simulated with real rigid-body physics at a fixed 240 Hz, so a machine
  behaves the same way every time you run it
- Made for touch: drag parts from the bin onto the bench, tap a part to select it, then
  turn, raise, lower, recolour or remove it with the buttons. Drag a part back into the bin
  to remove it. One finger orbits the camera on empty space; two fingers pinch to zoom
- Undo for every change on the bench (button, or `Z` / `Ctrl+Z`)
- After a run, coloured dots show where every ball, box and balloon went, until the next run
- Synthesised sound effects and a looping background tune (no audio files), with separate
  switches for music and effects. On iPad and iPhone the page asks for the `playback` audio
  session, so sound also plays when the device is on silent
- Keyboard and mouse still work: `R` turn, `E`/`Q` up/down, `C` colour, `X` remove,
  `Space` run, `V` camera view, `H` hint, `1`–`9` pick a part

## Project layout

| Path | What it is |
| --- | --- |
| `index.html` | The finished game: one self-contained file |
| `artifact.html` | The same page without the document skeleton, for hosting |
| `src/` | Sources: markup, styles and the game modules |
| `build.py` | Concatenates `src/` into the two HTML files |
| `tests/verify-levels.js` | Plays every puzzle's reference solution headlessly |

Source modules, in load order: `01_core` (constants, synthesised sound effects and music),
`02_render` (scene, procedural textures, materials, particles), `03_parts` (every gadget's
model and physics), `04_sim` (the deterministic physics world and goals), `05_levels`
(puzzle data and reference solutions) and `06_game` (building, touch and mouse input, undo,
trails, UI, camera, main loop).

```bash
python3 build.py
```

```bash
node tests/verify-levels.js
```

The test opens the built game in headless Chromium. For every puzzle it checks that the
reference solution wins, still wins when starting positions are nudged, and that an empty
bench does not win.
