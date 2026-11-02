# Colour pipeline

Soundstage grades its takes the way a dailies colourist would, and hands the grade to the editor's NLE:

1. **Takes → Match grade.** Every setup in a scene gets an ASC CDL (slope, offset, power, saturation) that matches its colour to a hero setup, judged in a perceptual space (OKLab).
2. **Coach → Grade jumps at a cut.** "Sc 1 · 1G is 0.4 stops warmer than Sc 1 · 1H", with a one-click Match.
3. **Look → Steal the look…** Pick a reference frame. Its tone curve, palette, grain and cast become the Look: the nearest film-stock preset, the grade sliders, a custom palette, and a CDL with a tone curve.
4. **Cut → Grade, and the NLE package.** Per-clip `.cdl`, one `.ccc`, 33³ `.cube` LUTs, the show look, and `*ASC_SOP` lines in the EDL, so Resolve and Avid can read each clip's CDL from the EDL and Premiere can load each clip's .cube as an Input LUT (see GRADE.txt; not yet tried in any NLE).

Everything runs on the CPU in numpy. There are no models and no downloads, and it needs no GPU.

## Colour space and the CDL

- **Images:** display-encoded Rec.709 / sRGB, 0..1. This is what every render and web image is.
- **CDL:** ASC CDL v1.2, applied to that display-encoded image, the way Resolve, Avid and Premiere apply a CDL on a Rec.709 timeline:
  `out = clamp(in × slope + offset, 0, 1) ^ power` per channel. Then `luma = 0.2126 R + 0.7152 G + 0.0722 B` and `out = luma + sat × (out − luma)`.
- **LUTs:** 33×33×33 `.cube`, Rec.709 in and out, red fastest. A clip's LUT is its CDL, then the show look's CDL, then the show tone curve.
- **Stops:** `exposure_ev` = log2(mean linear luminance / 0.18). `warmth_ev` = log2(R / B) and `tint_ev` = log2(G / √(R·B)), both of the mean linear light of the frame's mid-tones (10th to 90th percentile of lightness). A difference of 0.4 in `warmth_ev` is "0.4 stops warmer".

## Shot matching (`soundstage/grade/cdl.py fit_cdl`)

The take's CDL is chosen so that these statistics land on the hero's:

- OKLab lightness: mean, spread, and the 5th, 50th and 95th percentiles
- mean a and b
- mean chroma

There is a pull toward "no grade", so a take that already matches is left alone, and the fit never returns a CDL that makes the match worse. It works in three stages:

1. A per-channel quantile fit: least squares for slope and offset, with power found by a grid search.
2. A saturation match on mean chroma, by bisection.
3. A bounded Nelder–Mead refinement of all ten numbers on the OKLab objective.

A 320×180 frame takes about 1 s on one core.

The **Match grade** button is in the Takes bin, in both the Frame and List views.
- **Hero:** the selected card, else the scene's first setup (the master).
- **Which take:** each setup's hero take (the circled one, else its most finished).
- **Inserts:** left out. A key on the dirt is not coverage of the scene.

The CDLs are stored on the App node (`properties.ss_grade`), so they travel with the workflow, and they ride into the Cut as `shots[i].grade`.

## Grade continuity (`continuity.py`, `web/grade/grade.mjs checkCut`, Coach rule `grade_continuity`)

Each cut between two shots of one scene is compared. A cut is flagged when the exposure differs by ⅓ stop or more, or the warmth or tint by ¼ stop or more. Cuts between scenes are not judged.

- **What it measures:** each shot's best take, after its CDL.
- **Actions:**
  - **Match <shot> to it** matches the later shot to the one before it.
  - **Open Takes** opens the bin.
  - **Measure** appears when shots in the cut have not been measured yet.
- **Same numbers in both languages:** the Python and JavaScript checks give the same verdicts and sentences. `tests/test_grade.py` runs both.

## Steal the look (`steal.py`)

1. **Neutralise** the reference frame:
   - remove the grey-world cast on the mid-tones
   - spread lightness evenly
   - bring chroma to an ordinary level
2. **Fit the CDL** that takes the neutral version back to the reference (`fit_cdl`).
3. **Fit a 17-knot tone curve** for the rest, quantile to quantile on luma, blended halfway to the identity.

The Look gets the following:

- **Film stock:** the nearest of the 21 film-stock presets, matched on contrast, saturation, warmth, tint, black level, grain and black-and-white. The next two are named in the note.
- **Sliders:** contrast, saturation, warmth, grain and vignette (halation stays 0).
- **Palette:** a custom 5-swatch palette from k-means in OKLab. A black-and-white reference has none.
- **`look.colour = {cdl, curve, stock, source, name}`:** the Cut exports this as the show look. **.cube** downloads it on its own, and **Clear grade** drops it.

The film-stock profiles in `STOCK_PROFILES` are rough numbers written by eye from each stock's published character, in the same words the Look vocabulary uses. They are not measured characteristic curves. They only pick the preset; the CDL and the curve carry the actual grade.

## NLE package (`package.py`, mirrored by `web/grade/grade.mjs gradeFiles`)

With grades, `export_all` and the **Cut Export** node also write these files:

| File | For |
|---|---|
| `<cut>_grades.ccc` | every graded clip's CDL. The id is the clip name. |
| `<cut>_<clip>.cdl` | Avid, Baselight, Resolve's Apply CDL |
| `<cut>_<clip>.cube` | Resolve (Apply LUT), Premiere (Lumetri Input LUT). It includes the show look. |
| `<cut>_show.cdl` / `<cut>_show.cube` | the stolen show look. The .cdl cannot carry the tone curve. |
| `GRADE.txt` | what goes where, the colour space and the order |
| `<cut>.edl` | gets `*ASC_SOP (s s s)(o o o)(p p p)` and `*ASC_SAT s` under each graded event. Resolve reads these with "Use CDL from EDL"; Avid reads them too. |

The Cut editor's **Grade** button downloads the same files as one `.zip`. Without grades the package is byte-for-byte what it was before.

## Routes (`soundstage/grade/routes.py`)

`POST /soundstage/grade/stats`, `/match`, `/steal`, `/continuity`.

A frame can be given in one of three ways:
- `image`: a data: URL
- `url`: a ComfyUI `/view` URL
- `path`: a file inside output, input or temp

Videos are read as one frame with ffmpeg, at the middle by default (`at` sets where). One unreadable frame never fails the rest of the request.

## Files and tests

| Path | What |
|---|---|
| `soundstage/grade/colour.py` | sRGB / linear, OKLab, frame statistics |
| `soundstage/grade/cdl.py` | apply, fit, `.cdl` / `.ccc` / `.cube` / EDL writers, a `.cube` reader |
| `soundstage/grade/steal.py` | Steal the look |
| `soundstage/grade/continuity.py` | grade continuity |
| `soundstage/grade/package.py` | the NLE package files |
| `web/grade/grade.mjs` | the browser writers, and the continuity check |
| `tests/test_grade.py` | 22 tests on synthetic frames, including JS parity |
| `tests/js/grade.test.mjs` | 7 tests: writers, `gradeFiles`, the Coach rule |

## Limitations

- **Only checked on synthetic frames.** Matching, continuity and Steal the look have not been tried on real Soundstage renders or real film stills. The film-stock profiles are by eye.
- **Grey-world statistics.** A shot full of red brick reads warmer than one of blue sky in the same light. Matching and continuity compare shots of one scene for this reason, but a close-up on a red dress can still be pulled toward the wide.
- **One frame per take** (the middle of a video, or the still). A take whose light changes within the take is matched on that frame only.
- **The CDL can't do everything.** It can't fix a hue twist; that would need a 3D LUT fit. The `.cube` of a matched clip is still CDL-only.
- **Not tried in the NLEs.** The package has not been opened in Resolve, Avid or Premiere. The files follow the ASC CDL v1.01 schema and the Adobe/Resolve `.cube` format, and the tests check them by parsing them back.
- **No preview of the grade.** The App does not yet show a take graded in the viewer; the grade appears in the NLE.
