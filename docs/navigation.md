# Moving around the set

How the mouse, a trackpad and the keyboard move the camera around the 3D stage. The code is in [web/stage/navigation.mjs](../web/stage/navigation.mjs); the tests are in [tests/js/navigation.test.mjs](../tests/js/navigation.test.mjs).

**Still wrong (read first):** checked by unit tests and once in a live browser (the try-it build, Chrome, a mouse, 2026-11-07): orbit about the clicked point, zoom to the cursor, double-click focus, `F`, hold-right fly, both-buttons pan, each style, the compass, selection and gizmo drags all worked, with no console errors from navigation. The both-buttons chord, flying and the trackpad were driven by synthetic events there, not real hands: how they feel, Safari's pinch, and trackpad detection on real hardware are still unverified. That browser drew 3 to 16 frames a second, so flying covered about half the set speed (each frame counts at most 0.25 s). Trackpad detection is a guess: a mouse with smooth scrolling (some Logitech mice on a Mac) can be mistaken for a trackpad, and then scrolling orbits instead of zooming. If that happens, set **Navigation… › Scrolling** to *Mouse wheel*.

## The Soundstage style (the default)

| To | Mouse | Trackpad | Keys |
|---|---|---|---|
| Orbit about the point under the cursor | Drag on empty space | Two-finger scroll | |
| Pan | **Press left and right together and drag**, Shift+drag, or middle-drag | Shift + two-finger scroll | |
| Look around in place | Alt+drag on empty space (Alt+drag on an object still turns it) | | |
| Zoom toward the cursor | Wheel | Pinch | |
| Fly | Hold the right button: the mouse looks, `W` `A` `S` `D` `Q` `E` steer, the wheel sets the speed | | |
| Glide while a key is held | | | `W` `A` `S` `D` `Q` `E` (Shift: faster) |
| Go to what you clicked | Double-click (Free view only) | Double-tap | |
| Frame the selection | | | `F` |
| Turn to an axis view | Click the compass (top right); drag it to orbit | | |

- **Orbit about the cursor:** the camera turns about whatever is under the cursor when the drag starts (an object, else the floor, else the old target), so what you are looking at stays put. Close in, or inside a car or a room, a drag still looks around in place, so the camera never swings out through the doors.
- **Pan follows the cursor:** the point you grabbed stays under the pointer.
- **Both buttons:** a drag that started as an orbit, or a press on an object that hasn't started moving it, becomes a pan as soon as both buttons are down. The object never moves, and letting go is never a click. A drag on the gizmo, a live drag, a light or a pose is left alone.
- **Hold right to fly:** while the right button is held, `D` is fly right, even with a car selected. Without the right button, `D` on a selected car is still **Drive**. A right click without a drag is still a click: it selects, and the Identical? bar's right-click Fix menu still opens.
- **Double-click** only selects in the Camera view, so a stray double-click never moves the shot camera. Press `0` for the Free view first.
- **Camera view:** every move edits the shot camera's key at the playhead, and it is written once, when the motion stops.
- **Drive** keeps its own controls: none of this runs while you drive.

## Styles and settings

**Navigation…** (top left of the viewport, next to ↶ Last view) and the ⚙ on the hint line at the bottom right of the viewport open the settings, the style included (so it can be changed with the hint hidden). They are kept in this browser only.

| Style | Orbit | Pan | Dolly | Fly | Frame |
|---|---|---|---|---|---|
| Soundstage | Drag on empty space | Both buttons, Shift+drag, middle | Wheel | Hold right + WASD | `F` |
| Blender | Middle-drag (drag on empty space works too) | Shift+middle, both buttons | Ctrl+middle-drag, wheel | Hold right + WASD | `F`, Numpad `.`; `Home` = whole set; Numpad `1` `3` `7` front / right / top (Ctrl: the opposite side) |
| Maya | Alt+drag (drag on empty space works too) | Alt+middle, both buttons | Alt+right-drag, wheel | Hold right + WASD | `F`; Shift+`A` = whole set |
| Unreal | Alt+drag | Middle, both buttons | Alt+right-drag, wheel | Hold right + WASD, wheel = speed | `F`; a left drag on empty space moves forward and turns |

- In Maya and Unreal, Alt+drag on an object orbits instead of turning it, even when it starts on a gizmo arrow: turn it with the ring or `R`.
- In Blender, the numpad's `.` frames the selection; the main `.` still goes back to the set.
- In every style: a click selects, a drag on the selected object moves it, and the gizmo, the ring, light handles, `F`, `0`, `.` and `,` work the same.

| Setting | What it does |
|---|---|
| Style | Soundstage, Blender, Maya or Unreal (the same as the picker on the hint line). |
| Damping | Eases drags, scrolls and flying in and out, and lets a flick glide on. Off: the view moves exactly with the mouse. Off by default when the system asks for reduced motion. |
| Smoothness | How much easing (with damping on). |
| Invert up / down | Flips the up/down direction of an orbit and of looking around. |
| Scrolling | *Auto-detect*, *Mouse wheel* (scrolling always zooms) or *Trackpad* (two-finger scroll orbits). |
| Fly speed | Metres per second while flying with the right button held (the wheel changes it too). |
| Show the hint | The one-line reminder at the bottom of the viewport. ✕ hides it. |
