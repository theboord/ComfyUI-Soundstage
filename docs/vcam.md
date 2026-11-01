# Soundstage virtual camera (VCam) + stabilizer

Use a phone, tablet, Meta Quest or Apple Vision Pro as the shot camera, in the style of Unreal's
Live Link VCam. Walk the move, and Soundstage gives you camera keys for the stage timeline.

The "training wheels" are a **stabilizer** (a gimbal or warp stabilizer), not a move replacer. The
take keeps your path, timing, speed changes, drifts and reframes. Only shake is removed: tremor,
sensor jitter, footstep bob and the overshoot bumps when you start or stop. Snapping a take to a
textbook rig move (dolly, pan, crane, arc) is an optional **suggestion** and is never applied
automatically.

```
device page (/soundstage/vcam) --WebSocket ~30 Hz--> soundstage/vcam.py --send_sync("soundstage.vcam")--> ComfyUI tabs (live preview)
          \--- POST /soundstage/vcam/take (whole take) --> user/soundstage/takes/<id>.json --> stabilize() --> stage.state.camera_keys
```

## Phone viewfinder (the phone is the camera you look through)

**Phone viewfinder** in the stage's *Phone camera* row shows a QR code. Scan it, hold the phone sideways, tap **Start**:
the phone shows the live stage through the shot camera, full screen, in the App's Clay or Color look with the same lights.
It is not a video stream. The phone builds the same `Stage` (web/stage/stage.mjs) from the scene the desktop publishes
and renders it locally, so aiming has no network lag. The desktop keeps showing everything, and the shot camera there
follows the phone.

```
desktop App --POST /soundstage/vcam/scene (on every change), /sync (playhead, view)--> soundstage/vcam.py --WebSocket--> phone
phone --WebSocket {type:"vf"} live camera ~30 Hz, {type:"vfstate"} events--> vcam.py --send_sync("soundstage.vcam")--> desktop
phone --POST /soundstage/vcam/take (the recorded take, set space)--> desktop: camera keys + lens keys on the current shot
```

| on the phone | does |
|---|---|
| move the phone | aims the camera (gyro). Heading is relative to the shot camera; tilt and roll are absolute, so a level phone is a level camera. |
| **MOVE** stick, **UP** strip | walk (truck / dolly along the heading) and crane, eased |
| **Walk AR** (Android Chrome, https) | WebXR 6-DoF: walk the room to move the camera |
| drag the picture | pan / tilt trim (the only way to aim without motion sensors, e.g. on plain http) |
| **Re-centre** | back to the shot camera's framing at the current frame |
| pinch, **+ TELE / − WIDE** (hold) | smooth zoom, 10–300 mm (the rocker speeds up the longer you hold it) |
| **14 18 24 35 50 85 135** | the App's prime set (web/ui/cinegear.mjs) |
| tap the picture | focus on what is under your finger (a raycast, distance along the lens axis) |
| **FOCUS** chip | the focus ring (0.3 m … ∞), marks **A** / **B**, **Pull ⇄** racks between them over 0.5 / 1 / 2 / 3 s |
| **IRIS** chip | T1.4 … T22 in thirds, with a live depth-of-field preview (thin-lens circle of confusion, one gather pass: web/vcam/dof.mjs) and the DoF near/far readout |
| **●** | a 3-beat count-in, then records from the top of the shot in step with the action (the desktop plays along). Stops by itself at the shot's end, or tap ■. |
| after a take | it plays back on the phone and on the desktop. **Keep**, **Discard** (the shot gets its previous camera back) or **● Again** |
| **CLAY / COLOR**, **▦ Grid**, **Frame** | the view, rule-of-thirds and extra frame lines (2.39 / 1.85 / 16:9). The area outside the shot's own frame is dimmed surround. The level bar turns green within 1°. |
| **Level**, **Stabilize**, **DoF**, **Motion** | horizon lock (on by default), gimbal-strength smoothing of the take, the DoF preview, gyro on/off |

**What a take writes.** The take is recorded at the screen rate in set space and saved like any VCam take
(`/soundstage/vcam/take`, with `settings.space = "set"`). `web/vcam/vfcore.mjs takeToKeys` turns it into keys:

* Position, aim and focal length go through the stabilizer (`web/movefit/stabilize.mjs`): light filtering by default
  (strength 0.25, no lag) or a gimbal with **Stabilize** (0.75). Its reducer makes the shot's `camera_keys`.
* Focus distance, T-stop and roll get a light zero-phase smooth and become the shot's own **`lens_keys`**
  (`[{frame, focus_m, t_stop, roll?}]`). Keys are added where a pull or an iris change happens.
  `Stage._cameraAt` plays them: focus eases in diopters like a ring, the T-stop eases in stops. The lens therefore
  rides in `camera_track` with the move into the render nodes.
* The shot's rig is set to Free, because the take is the move. Discard restores the keys, the lens keys and the rig.

Both sides run the same function on the same take, so the phone's review and the desktop's keys match.

### Connecting the phone (the App runs on the pod, the Mac reaches it at 127.0.0.1:8189)

A phone can't open the Mac's `127.0.0.1`. Its motion sensors also only work on an **https** page. Run the bridge on the
Mac while the tunnel is up:

```bash
cd ~/OpenHiggsfieldContest/ComfyUI-Soundstage
python3 tools/vcam_bridge.py            # https://<mac>.local:8443 -> 127.0.0.1:8189 ; Ctrl-C to stop
```

* The bridge listens on the Mac's **Wi-Fi only**. Nothing reaches the internet, nothing changes on the pod, and the
  pod's ports stay SSH-only.
* Every phone needs the **pairing token** that the QR code carries (`?vk=…`, then kept as an HttpOnly cookie). Without
  it the answer is 401. `--new-token` un-pairs every phone.
* There is an **allow-list**. Even with the token, a phone can only reach the viewfinder page, its WebSocket, the
  take upload and the read-only files the stage loads (`/extensions/ComfyUI-Soundstage/…`, `/view`). `/prompt`,
  `/queue`, `/api/userdata`, `/upload`, the agent and every other route answer 403. The bridge forwards one request per
  connection, so this check runs on every request.
* The bridge registers its phone URL with the App (`POST /soundstage/vcam/pair`, re-sent every 30 s, expires after
  3 min). The desktop's QR code then points at the bridge. Without the bridge, the QR shows the page's own address and
  warns when that is a loopback address.
* **Certificate.** On the first run the bridge creates a small local CA in `~/.soundstage-vcam/` with `openssl`. If
  mkcert files `<mac>.local.pem` and `-key.pem` are already there (Option A below), it uses those instead. Install it on
  the phone once: open `http://<mac>.local:8444/` (that port serves only the certificate), install the profile, then on
  iPhone turn on Settings → General → About → Certificate Trust Settings → *Soundstage VCam local CA*. Android: Settings
  → Security → Install a certificate → CA certificate.
* For a quick try without a certificate, run `python3 tools/vcam_bridge.py --http`. Everything works except the motion
  sensors: drag the picture to aim.
* macOS asks once whether Python may accept incoming connections. Allow it, and stop the bridge (Ctrl-C) when done.

**Never** put the App on a public URL for this, and never open the pod's HTTP ports (the NDA rule). The bridge is the
LAN path. Option B below (a password-protected tunnel) is for off-LAN use with non-NDA work only.

### Viewfinder protocol

| message | from → to | |
|---|---|---|
| `{type:"vf", t, frame, recording, view, cam:{position, target, focal_mm, focus_m, t_stop, roll}}` | phone → desktops | the live camera, set space, ~30 Hz (1 Hz when still) |
| `{type:"vfstate", event, data}` | phone → desktops | `hello`, `arm`, `record`, `stop`, `keep`, `discard`, `bye` |
| `{type:"scene", rev, scene, sync}` | server → phones | on connect (the last one published) and on every desktop change |
| `{type:"sync", frame, playing, view, fps, frames, shot, take?}` | server → phones | the playhead; `take: {id, status: "applied", keys, lensKeys, shot}` after a take lands |

`GET /soundstage/vcam/viewfinder` serves `web/vcam/viewfinder.html`, whose modules load from `/extensions/<pack>/vcam/`.
The phone only rebuilds its set when the scene minus its cameras changes (`sceneSig`). A camera edit is patched in place.

| file | what |
|---|---|
| `web/vcam/viewfinder.html`, `viewfinder.mjs` | the phone page: renders the Stage, gestures, sensors, record / review |
| `web/vcam/vfcore.mjs` | pure: lens / focus / iris maths, framing, gyro, `VfRig`, `TakeRecorder`, `takeToKeys`, `reduceLensKeys`, protocol |
| `web/vcam/dof.mjs` | the depth-of-field pass |
| `web/vcam/desk.mjs` | the desktop half (QR popover, publishing, live preview, applying takes) |
| `web/vcam/qr.mjs` | a QR encoder (versions 1–10, checked against OpenCV's decoder) |
| `tools/vcam_bridge.py` | the LAN bridge |
| `tests/js/viewfinder.test.mjs`, `tests/test_vcam_viewfinder.py` | tests |

## Files

| file | what |
|---|---|
| `web/movefit/stabilize.mjs` | pure JS (no DOM, no three.js): `stabilize`, `suggestRig`, `reduceKeys`, `stageCameraAt`, quaternion helpers |
| `web/vcam/index.html`, `web/vcam/device.mjs` | the device page, served at `/soundstage/vcam` |
| `web/vcam/live.mjs` | ComfyUI-side helpers: `listenVcam`, `LiveVcam`, `fetchTake`, `takeToCamera`, `anchorFromCamera` |
| `soundstage/vcam.py` | aiohttp routes and relay; `register()` adds them to `PromptServer.instance.routes` |
| `tests/js/stabilize.test.mjs`, `tests/js/live.test.mjs`, `tests/js/synthetic.mjs`, `tests/test_vcam.py` | tests |

Tests: `node --test tests/js/*.test.mjs` and `python -m pytest tests/test_vcam.py -q`.
(On Node 26, `node --test tests/js/` with a bare directory does not work. Use the glob.)

## Wiring it in (integrator)

1. `__init__.py`: `from .soundstage import vcam as _vcam; _vcam.register()`. Call it once.
   The function is idempotent and must run at import time, before the server starts.
2. `web/soundstage.js`: `import { listenVcam, LiveVcam, fetchTake, takeToCamera, anchorFromCamera } from "./vcam/live.mjs";`
   and wire it in like the example at the top of `live.mjs`. Suggested UI on the stage: a "VCam" toggle that
   shows the live pose as the shot camera (`LiveVcam.update`). When a `take` event arrives, add a takes list
   with a Strength slider that re-runs `takeToCamera(take, {overrides:{strength}})`. Show a "Snap to <rig>?"
   button only when `result.rig` is non-null, and apply `result.rig.snapped.keys` only when that button is clicked.
3. `rsync -rlt` to the pod and restart ComfyUI as usual.

`web/vcam/*.mjs` are `.mjs` on purpose: ComfyUI auto-loads every `.js` under `WEB_DIRECTORY` as an extension.

## Connecting a device

Open **`/soundstage/vcam`** on the device, on the same ComfyUI that shows the stage.

Browsers only expose WebXR and motion sensors in a **secure context**: `https://` or `http://localhost`.
On plain `http://` over the LAN, the page still loads and Desktop test mode works, but it shows
"Motion sensors need https". The pod is only reachable from the Mac through the SSH tunnel
(`http://127.0.0.1:8189`), so a device needs a secure route to the Mac. Choose one route below.
**Nothing here is set up automatically. Opening any port or tunnel is Mike's call.**

### Option A: LAN https on the Mac (nothing public; recommended for the demo)

The phone talks to the Mac over local Wi-Fi with a locally trusted certificate. The Mac forwards to
the SSH tunnel. This works like Unreal Live Link, with no exposure to the internet.

```bash
brew install mkcert caddy
mkcert -install                                   # local CA, trusted by the Mac
H="$(scutil --get LocalHostName).local"           # e.g. mikes-mac.local
mkdir -p ~/.soundstage-vcam && cd ~/.soundstage-vcam && mkcert "$H"
cat > Caddyfile <<EOF
https://$H:8443 {
  tls $H.pem $H-key.pem
  reverse_proxy 127.0.0.1:8189      # the SSH tunnel to the pod's ComfyUI
}
EOF
caddy run --config Caddyfile                      # Ctrl-C to stop
```

* Anyone on the same Wi-Fi can reach this port while Caddy runs, so only use it on a trusted
  network. Add `basic_auth` to the site block if the network is shared.
* Trust the CA on the device. Send `$(mkcert -CAROOT)/rootCA.pem` to the iPhone (AirDrop), install the
  profile, then turn it on in Settings → General → About → Certificate Trust Settings. Android: Settings →
  Security → Install certificate → CA.
* Open `https://<mac-name>.local:8443/soundstage/vcam` on the device.
* macOS asks once whether Caddy may accept incoming connections. Allow it for the session and stop Caddy afterwards.
* Caddy passes the `Host` header through unchanged. ComfyUI rejects requests whose `Origin` host differs
  from `Host`, so a proxy that rewrites `Host` would get 403s.

### Option A2: USB, no certificate (Android phone or Quest in developer mode)

`http://localhost` counts as secure. Forward the port over USB:

```bash
adb reverse tcp:8189 tcp:8189
```

Then open `http://localhost:8189/soundstage/vcam` in Chrome or the Quest Browser.

### Option B: a password-protected temporary tunnel (works off-LAN)

ComfyUI has **no authentication**. Anyone who reaches a public URL can run workflows and read the
user directory. A tunnel must therefore sit behind a password, stay up only for the session, and
**never be opened in front of an NDA pod or NDA work**. Examples:

```bash
ngrok http 8189 --basic-auth "vcam:<long-random-password>"
```

The other way is a `cloudflared tunnel --url https://localhost:8443` in front of the Caddy proxy
from Option A, with `basic_auth` enabled in the Caddyfile. Close the tunnel when done (Ctrl-C) and
change the password each time.

## What each device does

| device / browser | button | tracking |
|---|---|---|
| Android Chrome (ARCore) | **Start AR camera** | 6-DoF. Walk the room. The page stays on screen (dom-overlay), so Record and the sliders work during the move. |
| Meta Quest Browser | **Start AR** (passthrough) or **Start VR** | 6-DoF. With "Use controller as camera" on, the right controller's pointer is the lens. Trigger = record/stop, grip = recenter. |
| Apple Vision Pro Safari | **Start VR camera** | 6-DoF head pose. Pinch = record/stop (no DOM overlay in immersive-vr). |
| iPhone / iPad Safari | **Enable motion** (permission prompt) | 3-DoF rotation from the gyro, plus thumbsticks: left = move, right = up/down. |
| Desktop | **Desktop test mode** | Drag the viewfinder to look; use the sticks to move. Exercises the whole pipeline without a device. |

Controls:

* **Record/Stop**: the big button. Space bar works on desktop.
* **Strength**: 0 = raw, 100 = silky Steadicam.
* **Keep handheld**: how much of the original sway to keep.
* **Scale ×**: 1 m of hand movement = N m on set, from 1 to 20.
* **Lens mm**: recorded per sample.
* **Horizon lock**: zero roll.
* **Recenter**: the current position and heading become the origin and "straight ahead".

The readout shows the set-space offset (after scale), pan/tilt/roll, the sample rate and the network round trip.

When you stop, the take is POSTed to the server. The page also stabilizes it locally and shows the
key count and any rig suggestion, for example: "Saved take 3: 6.2 s, 371 samples → 9 keys · looks like a dolly-in".

## The stabilizer: JS API

```js
import { stabilize, suggestRig } from "./movefit/stabilize.mjs";

const { frames, keys, info } = stabilize(samples, {
  strength: 0.6,        // 0 = raw .. 1 = silky
  horizonLock: false,   // zero roll
  keepHandheld: 0,      // 0..1, re-add this much of the original 0.2-2.5 Hz sway (footsteps, breathing), never tremor
  fps: 24,
  focusDistance: 5,     // target = position + forward * focusDistance (metres)
  focal_mm: 35,         // used when samples carry no focal_mm
  scale: 1,             // 1 m of hand movement = scale m on set (scaled about the take's first frame)
  anchor: { position: [x, y, z], yaw: deg },   // optional: first frame lands here, heading turned to yaw
  startFrame: 0,
  keyTolerance: 0.015,  // metres, see "keys" below
  maxKeys: 96,
});
stage.state.camera_keys = keys;   // [{frame, position, target, focal_mm}]: the stage's own format
```

* **`samples`**: `[{t, position:[x,y,z], quaternion:[x,y,z,w], focal_mm?}]`. `t` is in seconds, at any rate,
  any order, duplicates allowed. Units are metres, Y up, and the camera looks down its local −Z
  (WebXR / three.js). Quaternion sign flips are handled.
* **`frames`**: one per output frame at `fps`, `[{frame, t, position, quaternion, target, focal_mm}]`. This is the
  stabilized move itself (use it for exports or as a per-frame `camera_track`).
* **`keys`**: a reduced key list. Playing them back through the stage's own interpolation
  (`Stage._cameraAt`, mirrored as `stageCameraAt` and checked by a parity test) stays within
  `keyTolerance` across the path. Along the path it may also slip by up to a third of a frame of travel,
  an invisible timing error that saves a lot of keys in fast moves. Typical results: a 5 s dolly gives 6 keys,
  an 8 s walk-and-push gives about 14, and a crane with a hold gives about 11.
* **`anchor`**: use `anchorFromCamera(stage._cameraAt(frame))` from `live.mjs` to start the take at the current shot camera.
* **`info`**: `{duration, fps, frames, keys, maxKeyError, samples, strength, horizonLock, keepHandheld}`.

**How it works.** Each output frame is a Gaussian-weighted **local-quadratic** fit of the raw samples
around that instant (Savitzky-Golay with a Gaussian window). The fit is zero-phase, so there is no lag,
and it is unbiased for constant acceleration, so eases, speed-ups and stops keep their shape and timing.
The window adapts to the operator's speed, measured with a firm fixed-width fit so that shake doesn't
read as speed:

* When the camera is slow or holding, the cut-off drops toward about 0.22 Hz at strength 1. Holds turn rock steady.
* When it is fast, the cut-off is about 0.7 Hz at strength 1. The move keeps its energy, and tremor at 6–12 Hz is
  still gone at any strength above 0.
* After fast motion, the window can only widen slowly. A wide "holding" window therefore can't reach
  back into the move and smear the landing, while the 2–3 Hz overshoot bump after a stop is still removed.

Rotation gets the same treatment on hemisphere-aligned quaternions, renormalised, with its own angular-speed
adaptation. Horizon lock rebuilds each orientation from its forward vector with world-up. Keep handheld blends
toward a light (2.5 Hz) fit of the same samples.

**Keys.** For a fixed set of key frames, the stage's Catmull-Rom playback is linear in the key values.
Key positions and targets are therefore solved by least squares, with first and last keys pinned to the
take, so that the playback hugs the path. The reducer picks the smallest evenly spaced key set that fits,
because uniform Catmull-Rom kinks when neighbouring segments differ in length. It then splits only the
segments that still stick out.

Measured on synthetic takes (25 seeds; tremor, sensor noise, footstep bob, overshoot bumps), strength 1:

* High-frequency jitter drops to ≤ 1.8 % of raw.
* The path stays within 1.6 cm of the intended move.
* Holds stay put within 2 cm.
* There is no lag: the matching frame is within ±1 frame.

### Optional rig suggestion

```js
const s = suggestRig(frames /* or raw samples */, opts);
// null for free handheld, else:
// { type: "dolly"|"pan"|"tilt"|"crane"|"arc"|"lockoff", label: "dolly-in", confidence: 0.4..0.95,
//   question: "This looks like a dolly-in. Snap it?", snapped: { frames, keys } }
```

The snapped alternative straightens the geometry: a line, a fixed pivot, a vertical mast or a circle
around the subject. **Progress along it still follows the operator's own timing**, so a pause in the
take stays a pause. Show it as a button and never apply it automatically.

### `live.mjs` (ComfyUI side)

* `listenVcam(api, {onPose, onState, onTake})` returns an unsubscribe function.
* `new LiveVcam().update(posePayload, anchor)` returns `{position, target, focal_mm, quaternion}`. Call `.zero()` on `record`.
* `listTakes(api)` and `fetchTake(api, id)`.
* `takeToCamera(take, {anchor, overrides, suggest})` returns `{frames, keys, info, rig}`. The settings recorded on the device are the defaults.
* `anchorFromCamera({position, target})` returns `{position, yaw}`.

## Server API and the `soundstage.vcam` event

| route | |
|---|---|
| `GET /soundstage/vcam` | device page |
| `GET /soundstage/vcam/device.mjs`, `/stabilize.mjs` | its modules (whitelist; nothing else is served) |
| `GET /soundstage/vcam/ws?device=<id>` | WebSocket. The device sends `pose` / `state` / `ping` JSON; the server answers `hello` and `pong` |
| `POST /soundstage/vcam/pose` | the same messages over HTTP (one object or an array), used as a fallback |
| `POST /soundstage/vcam/take` | `{name?, device?, mode?, settings?, samples}` → stored take summary (`{id, name, created, duration, device, mode, settings, samples: <count>}`) |
| `GET /soundstage/vcam/takes` | summaries, newest first |
| `GET /soundstage/vcam/take?id=<id>` | full take |
| `GET /soundstage/vcam/status` | connected devices |

Every message is re-broadcast to all ComfyUI tabs with `PromptServer.instance.send_sync("soundstage.vcam", payload)`.
Poses are throttled to 40 Hz per device. Devices send about 30 Hz while moving and a 1 Hz keep-alive when idle.

```jsonc
// pose
{"type": "pose", "device": "cam-ab12c", "mode": "ar|vr|3dof|desktop", "recording": false,
 "t": 1234.567, "position": [x, y, z], "quaternion": [x, y, z, w], "focal_mm": 35,
 "settings": {"strength": 0.6, "keepHandheld": 0, "scale": 1, "focal_mm": 35, "horizonLock": false},
 "server_time": 1793168538.88}
// state: event = connected | disconnected | hello | settings | record | stop | recenter
{"type": "state", "device": "...", "mode": "...", "recording": true, "settings": {...}, "event": "record", "server_time": ...}
// take saved
{"type": "take", "device": "...", "id": "20261028-201502_take_3", "name": "take 3", "created": "...",
 "duration": 6.2, "mode": "ar", "settings": {...}, "samples": 371}
```

Pose positions are in **hand space**: metres since the device's last Recenter, before scale. Scale and
placement on the set happen on the ComfyUI side (`LiveVcam`, `takeToCamera`), so takes stay raw and can be re-used.

Take file (`<ComfyUI user dir>/soundstage/takes/<id>.json`):
`{version: 1, id, name, created, device, mode, settings, duration, samples: [{t, position, quaternion, focal_mm?}]}`,
with `t` starting at 0. Validation: numbers must be finite, quaternions are normalised, at most 200k samples, and ids match
`YYYYMMDD-HHMMSS[-n]_slug` (so a request can't traverse paths).

## Known limits

* iOS Safari is 3-DoF: there is no positional tracking without WebXR. Use the sticks, or an Android phone, Quest or Vision Pro to walk the move.
* Phone AR tracking drifts slowly over long takes. Recenter between takes.
* Vision Pro immersive-vr shows no page UI. Record with a pinch and adjust sliders before entering.
* The original device page (`/soundstage/vcam`) has no 3D view of the set. It is still the page for Quest / Vision Pro
  headsets. Phones should use the **Phone viewfinder** above, which renders the set itself.
* The viewfinder's depth of field is a preview (one gather pass). The render's own depth of field comes from the model.
