# Soundstage brand

**Mark.** A clapperboard whose striped sticks double as stage-light beams, with a play triangle cut out of the slate. Reads at 16-32 px.

**Wordmark.** `SOUNDSTAGE` in **Futura Condensed ExtraBold** (macOS system font: `/System/Library/Fonts/Supplemental/Futura.ttc`, face index 4), all caps, tracking +0.04 em. In `logo.svg` the letters are outlined to paths, so no font is needed to display it.

**Colours.**

| | Hex | Use |
|---|---|---|
| Soundstage yellow | `#f2ff59` | mark, wordmark, accent |
| Stage black | `#0e0d10` | backgrounds, social cards |
| Panel black | `#141118` | App panels |

**Files.**

- `logo.svg`: horizontal lockup, vector, transparent background (yellow on dark only).
- `logo_mark.svg`: the mark alone (favicons, avatars).
- `logo.png`: lockup, 1600 px wide, transparent.
- `logo_dark.png`: lockup on `#0e0d10`, 1600 px wide, for social and light backgrounds.

**Usage.** Always yellow on a dark ground; never on white (use `logo_dark.png` there). Keep clear space of at least the slate's height around the lockup. Don't recolour, stretch, outline or add effects. In the App, the header uses the inline mark plus CSS: `font-family: "Futura Condensed ExtraBold", "Bebas Neue", Oswald, "DIN Condensed", "Avenir Next Condensed", Impact, sans-serif; letter-spacing: .04em; text-transform: uppercase`.
