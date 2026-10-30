# Source fidelity: what goes in also goes out the same

Footage you bring into Soundstage keeps its own spec all the way to delivery. Soundstage reads the spec once, when
the footage comes in, and keeps it with the scene and the shot. The NLE exports point at the **camera original**
with its own timecode, frame rate and reel, so your online conform pulls full-quality frames. The Layer Pack
renders generated layers at the **source size, frame rate and timecode**. Nothing is downscaled or retimed
without saying so: anything that can't match is written into the export.

This is the usual offline/online split. Soundstage works at model resolution (LTX makes 1280×704 at 24 fps, for
example). Your editor conforms to the camera originals at full quality.

## 1. The source spec on import

`GET /soundstage/source_spec?filename=&subfolder=&type=input` runs `ffprobe` on the server
(`soundstage/footage/sourcespec.py`) and returns:

| Field | Example |
| --- | --- |
| `width`, `height`, `sar` | 3840, 2160, 1:1 |
| `fps`, `fps_rational`, `vfr` | 23.976, `24000/1001`, false |
| `frames`, `duration`, `tc_start`, `reel` | 240, 10.01, `01:02:03:04`, `A001C003` |
| `codec_label`, `container`, `pix_fmt` | ProRes 4444, mov, yuva444p10le |
| `bit_depth`, `chroma`, `alpha` | 10, 4:4:4, true |
| `primaries`, `transfer`, `matrix`, `range`, `log_curve` | bt709, bt709, bt709, limited, "" |
| `colour` | Rec.709 / Rec.2020 PQ / S-Log3 (log curves come from camera metadata) |
| `path`, `file`, `camera_original`, `proxy` | the file you brought in, and the RAW it was made from |
| `line` | `Source: 3840×2160 · 23.976 · ProRes 4444 · Rec.709 · 10-bit 4:4:4 · TC 01:02:03:04` |

Where footage comes in, and where the spec is kept:

| Path in | Spec kept in | Shown |
| --- | --- | --- |
| **Video → Stage** (Import an image as… → Video clip) | `scene.reference.source`, and on the setup that re-shoots it (`scene.shots[0].source`) | status line after the rebuild; **SRC** chip and Source line in the Cut |
| **Backdrop plate** (Import an image as… → Backdrop) | `scene.backdrop.source` | status line |
| **Mocap capture** from a clip | the take's `source` (the take already runs at the clip's own rate) | capture status |
| Cut shots | `shot.source` (from the stage setup) | Cut bin |

Cast references, Paint Studio documents, cut-out cards, splats and meshes are reference pictures. Soundstage
regenerates them rather than delivering them, so they get no spec.

### Camera RAW (RED .R3D, Blackmagic .braw, ARRIRAW .ari/.arx, Canon .crm, Nikon .nev)

These formats can't be decoded without the camera makers' SDKs, and Soundstage doesn't ship those SDKs. Pick the
RAW file in Video → Stage and Soundstage says so, then asks for the proxy (ProRes, DNxHR or H.264) made from it.
The proxy is probed, marked `proxy: true`, and given `camera_original: A001_C002_0101XY.R3D` and a camera-style
reel (`A001_C002`). Everywhere it appears the UI says: *"Working from a proxy; your export relinks to the camera
original."*

## 2. Delivering at the source spec

### NLE exports (Cut → Avid EDL, Premiere XML, FCPXML, OTIO)

`web/cut/exporters.mjs`, with a byte-for-byte Python twin in `soundstage/cut/export.py`:

- **Sequence settings match the source.** A cut with imported footage takes the first source's size, and its
  exact rate when the speed is the same (24 → 23.976 is a conform). Set `match_source: false` on the project to
  keep the stage size. The OTIO timeline metadata records it as `delivery`.
- **Imported shots link the camera original.** A shot with a source and no generated video yet (clay or Look), or
  one marked `use: "original"`, is exported as the camera original. It keeps its own reel, its own source
  timecode (start TC + in, counted at its own rate), and its own size, rate and colour. FCPXML gives it a separate
  `<format>`, and Premiere XML a file with its own `<rate>`, `<timecode>` and `<reel>`. Plate stand-ins get a
  `SOURCE plate stand-in: relink to the Final render` note. Proxies get `cut from the proxy …: relink to the
  camera original …`.
- **Generated shots** keep their own media at the project's delivery spec. They name their plate:
  `* SOUNDSTAGE PLATE: <path> REEL <reel> TC <tc>` in the EDL, a comment in Premiere XML, and
  `metadata.soundstage.source` in OTIO.
- **Rates that don't match are flagged, not hidden.** If the source runs at 25 fps in a 24 fps sequence, its
  source frames are mapped by time, and every export carries
  `source is 25 fps in a 24 fps sequence: convert the rate on conform`.

### Layer Pack (Soundstage · Layer Pack: Export)

`match_source` defaults to on, and `source_spec` is an optional input. The Layer Pack uses the spec from the
Video → Stage scene or the backdrop plate (through *Add All Actors*), or one you wire in:

- **Size:** layers are scaled with lanczos to the source size. When the model's frame shape differs slightly
  (1280×704 into 3840×2160), the picture is centre-cropped, by 2.2% in that example. The camera's sensor width is
  narrowed to match. A crop of more than 5% (a portrait plate on a landscape stage) is refused and noted, and the
  layers keep the generated size.
- **Frame rate:** 24 → 23.976 is tagged frame for frame (the standard pull-down conform: 0.1% slower, no frames
  added or dropped). A different speed (25, 30, 50, 60) is **not** retimed. The pack stays at the generated rate
  and says so.
- **Timecode:** the ProRes 4444 layers and the preview carry the source's start timecode, so they conform over the
  plate.
- **Colour:** ProRes is tagged Rec.709 (`-color_primaries/-color_trc/-colorspace bt709`), which matches Rec.709
  and untagged sources. Generated pictures are SDR Rec.709. For Rec.2020, P3, PQ, HLG or log sources the pack
  says so rather than mislabelling Rec.709 pixels. Convert them in the conform, for example with a Resolve CST.
- **Bit depth:** ProRes 4444 is 10-bit with 16-bit alpha, and the depth and multilayer EXRs are float. The
  generated pixels carry 8 bits of real detail, and the pack says so for 12-bit sources.

Every decision is listed in `manifest.json → delivery.notes`, in `README.txt` and in the node's output text.

## What can't match, and why

| Can't match | Why | What Soundstage does |
| --- | --- | --- |
| Decoding R3D / BRAW / ARRIRAW | needs the vendor SDKs | works from your proxy, exports relink to the camera original |
| Frame rates other than the generated one (e.g. 25 vs 24) | the video model generates its own frame count | delivers at the generated rate, flags it everywhere |
| Log / HDR / wide-gamut colour on generated layers | the models make SDR Rec.709 pictures | delivers Rec.709-tagged, notes the source space |
| Real detail beyond 8 bits, or beyond model resolution, in generated layers | model output | 10-bit ProRes 4444 and float EXRs at source size; nothing invented |
| The Cut's one-video assembly | an H.264 review copy | use the NLE export for the conform |

Tests: `tests/test_source_fidelity.py` (it makes its own media with ffmpeg's testsrc2) and
`tests/js/sourcespec.test.mjs`.
