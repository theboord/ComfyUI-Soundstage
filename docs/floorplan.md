# Floor plan to true-scale interior (`POST /soundstage/plan`)

The route turns a floor-plan image or a dimension description into the interior spec that `web/stage/interior.mjs` builds. The code is in `soundstage/floorplan/` and the route is registered from the root `__init__.py` tuple as `floorplan.routes`.

## Request
- `image`: a file name in ComfyUI's input folder, or a data URL. A data URL is saved as `ss_plan_<hash>.png`.
- `text`: a dimension description.
- `ceiling_m`: optional.
- `vlm`: defaults to `true`.

## Image path
1. **Pixels** (`raster.py`, scipy, about 0.1–0.7 s), in three steps:
   - **Walls:** the large dark connected pieces. Text, door swings and furniture symbols are dropped.
   - **Door and window gaps:** a gap is bridged and recorded as an opening when it has wall on both sides and is under 30% of the image wide. A gap with wall on one side only (a door next to a corner) must be under 12%, which stops T-junctions being read as doors.
   - **Rooms:** the enclosed free regions.
2. **Names and labels:** `qwen3.5_4b_bf16` reads the image through the ComfyUI queue, never on the GPU directly. The graph is CLIPLoader → LoadImage → TextGenerate(image) → PreviewAny. The model's boxes (0–1000 grid, roughly placed) are only used to match names to the measured rooms.
3. **Scale and consistency:**
   - Scale is the median pixels-per-metre over all labelled rooms. Labels are read as wall-centre sizes, and m, mm, cm and feet/inches are all accepted.
   - Each label is checked against its drawn size. If they differ by more than 12%, a warning is added, e.g. "Hall is labelled 1.2×1.2 but drawn 1.2×2.4; used 1.2×2.4".
   - With no labels, the scale comes from an overall "W x D m wall to wall" in the text. With neither, the plan is assumed to be 12 m across, with a warning.
4. **Clean-up:**
   - Edges are snapped to shared wall centre-lines, rounded to 5 cm, and the plan's top-left becomes (0, 0).
   - Room sizes are clamped to 0.7–40 m, and overlaps are flagged.
   - Gaps become `door` (interior), `opening` (interior and wider than 1.3 m) or `window` (exterior; a hall's exterior gap is a door).

## Text path
Rules only, about 10 ms. It reads:
- `nLDK` / `nDK`, "2 bedroom", "one-bed";
- rooms named with or without a size, e.g. "bathroom 2x2" or "a 3 x 3.5 bedroom";
- the footprint ("10 m × 8 m wall to wall", or else the first size, or else the area in sqm);
- the ceiling height.

The template layout puts service rooms (bath, WC, kitchen, study…) down the west wall with the hall last so it absorbs the slack. Bedrooms go down the east wall, and the main room (LDK / living / studio) takes the middle. Doors connect each side room to the main room, the entrance is on the hall, and windows go on exterior walls.

With no overall size or area in the text, the footprint is built around the rooms, so every stated size is kept: "living room 5x4" comes out 4 × 5 m (turned so the long side runs down the plan when the side columns are deep), and slack under the main room becomes an Entry with a door north into it. A bedroom with a stated size keeps it, and the rest of its column becomes a Closet (or a Hall when 2.2 m or more). If the slack under the main room is under 0.9 m, the room grows to fill it and a warning says by how much. Service rooms take their column's width and keep their stated depth.

## Fixtures
Fixtures are templates per room kind, using library kinds: bed, sofa, kitchen_counter, fridge, dining_table, tv, bath, toilet, washbasin, wardrobe, desk, bookshelf, houseplant, and so on.
- Each piece backs onto its wall, or the opposite wall if there's a door on it. Windows are allowed.
- It then slides to the free spot nearest the wall's centre.
- Pieces that don't fit are dropped, and pieces never overlap.
- **`x`/`z` are absolute plan metres** (the object's centre). `rotation_deg` is about +Y, and 0 means the piece's back is against the north wall.

## On the stage
The stage turns the plan 180° (a rotation, never a mirror) so the top of the page is north: +Z, which is the Top view's "N ↑" and where the sun's azimuth is measured from. The drawing then reads the same way up in the Top view, and a plan's north window really faces north. Fixture rotations turn with it. New interiors are stored with `north_up: true`. Interiors saved before this have no flag and keep the old mapping, so they reload unchanged (web/stage/interior.mjs `toStage`).

## Timings (RTX 6000 Ada pod)
- Text: about 10 ms.
- Image: about 0.1–0.7 s for pixels, plus about 31 s of VLM execution with the model warm.
- Queue wait is extra when a render is running; the route waits up to 300 s.
- If ComfyUI caches an identical repeat, it executes in about 30 ms.

## Tests
`tests/test_floorplan.py` (20 tests):
- three synthetic PIL plans: a labelled plan with a mislabelled hall and door/window gaps; an unlabelled plan scaled from text; a plan labelled in feet;
- the no-model fallback;
- four text specs (they must tile the footprint exactly);
- fixtures never overlapping;
- the HTTP route with a stubbed VLM.
