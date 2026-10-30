"""Floor plan -> interior spec: synthetic plans drawn with PIL, text specs, and the HTTP route."""
import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

pytest.importorskip("scipy")
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from soundstage.floorplan import raster, routes, spec  # noqa: E402

PX = 80  # pixels per metre in the synthetic drawings
OX = OZ = 60


def _font():
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(f, 24)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_plan(rooms, doors=(), size=(1100, 900), wall=6):
    """rooms: (name, x, z, w, d, label) in metres (wall centre-lines). doors: (axis, line_m, a_m, b_m) gaps."""
    im = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(im)
    f = _font()
    for name, x, z, w, dd, label in rooms:
        d.rectangle([OX + x * PX, OZ + z * PX, OX + (x + w) * PX, OZ + (z + dd) * PX], outline="black", width=wall)
        d.text((OX + x * PX + 14, OZ + z * PX + 14), name, fill="black", font=f)
        if label:
            d.text((OX + x * PX + 14, OZ + z * PX + 44), label, fill="black", font=f)
    for axis, line, a, b in doors:  # erase a stretch of wall
        if axis == "h":
            y = OZ + line * PX
            d.rectangle([OX + a * PX, y - wall, OX + b * PX, y + wall], fill="white")
        else:
            x = OX + line * PX
            d.rectangle([x - wall, OZ + a * PX, x + wall, OZ + b * PX], fill="white")
    return im


def fake_vlm(rooms, size, jitter=40):
    """What qwen3.5 returns: names + verbatim labels, boxes on a coarse 0-1000 grid (deliberately off)."""
    W, H = size
    out = []
    for i, (name, x, z, w, d, label) in enumerate(rooms):
        box = [(OX + x * PX) / W * 1000, (OZ + z * PX) / H * 1000, (OX + (x + w) * PX) / W * 1000,
               (OZ + (z + d) * PX) / H * 1000]
        j = jitter * (1 if i % 2 else -1)
        out.append({"name": name, "label": f"{name}\n{label}" if label else "",
                    "bbox_px": [box[0] + j, box[1] - j, box[2] + j, box[3] + j]})
    return {"rooms": out}


# plan A: four rooms, all labelled; the Hall is labelled 1.2 x 1.2 but drawn 1.2 x 2.4 (the Jutsu catch)
PLAN_A = [("LDK", 0, 0, 5.4, 6.0, "5.4 x 6.0"), ("Bed 1", 5.4, 0, 4.6, 3.6, "4.6 x 3.6"),
          ("Bath", 5.4, 3.6, 2.0, 2.4, "2.0 x 2.4"), ("Hall", 7.4, 3.6, 1.2, 2.4, "1.2 x 1.2")]
DOORS_A = [("v", 5.4, 1.2, 2.1), ("h", 3.6, 7.6, 8.4), ("h", 6.0, 1.5, 3.3)]   # LDK-Bed, Bed-Hall, LDK window
# plan B: no labels at all, overall size given in the text
PLAN_B = [("Living", 0, 0, 6.0, 4.0, ""), ("Kitchen", 6.0, 0, 3.0, 4.0, ""), ("Bedroom", 0, 4.0, 9.0, 3.5, "")]
# plan C: feet labels and a corridor
PLAN_C = [("Master", 0, 0, 4.2672, 3.6576, "14' x 12'"), ("Corridor", 4.2672, 0, 1.2192, 3.6576, "4' x 12'"),
          ("Study", 5.4864, 0, 3.048, 3.6576, "10' x 12'")]


def _room(sp, name):
    return next(r for r in sp["rooms"] if r["name"] == name)


def test_pixels_find_every_room_and_the_door_gaps():
    im = draw_plan(PLAN_A, DOORS_A)
    px = raster.read_plan_pixels(im)
    assert len(px["rooms"]) == 4
    assert all(r["fill"] > 0.95 for r in px["rooms"])
    assert len(px["gaps"]) >= 3
    assert 3 <= px["wall_px"] <= 9


def test_plan_a_true_scale_and_the_label_catch():
    im = draw_plan(PLAN_A, DOORS_A)
    sp = spec.from_pixels(raster.read_plan_pixels(im), fake_vlm(PLAN_A, im.size))
    assert sp["source"] == "image" and sp["units"] == "m"
    for name, _, _, w, d, _ in PLAN_A:
        r = _room(sp, name)
        assert abs(r["w"] - w) < 0.15 and abs(r["d"] - d) < 0.15, r
    assert any("Hall is labelled 1.2×1.2 but drawn 1.2×2.4" in w for w in sp["warnings"]), sp["warnings"]
    # shared walls coincide exactly: LDK's east edge is Bed 1's west edge
    assert _room(sp, "LDK")["x"] + _room(sp, "LDK")["w"] == _room(sp, "Bed 1")["x"]
    kinds = {(o["type"], o["room"], o["wall"]) for o in sp["openings"]}
    assert any(t == "door" for t, _, _ in kinds)
    assert any(t == "window" and r == "LDK" and w == "S" for t, r, w in kinds)
    assert any(f["kind"] == "bed" and f["room"] == "Bed 1" for f in sp["fixtures"])
    assert any(f["kind"] == "bath" for f in sp["fixtures"])


def test_plan_b_scale_from_overall_text_when_unlabelled():
    im = draw_plan(PLAN_B)
    sp = spec.from_pixels(raster.read_plan_pixels(im), fake_vlm(PLAN_B, im.size), text="9 x 7.5 m wall to wall")
    assert abs(_room(sp, "Living")["w"] - 6.0) < 0.2 and abs(_room(sp, "Bedroom")["w"] - 9.0) < 0.2
    assert "overall dimensions" in sp["warnings"][0]


def test_plan_c_feet_labels():
    im = draw_plan(PLAN_C)
    sp = spec.from_pixels(raster.read_plan_pixels(im), fake_vlm(PLAN_C, im.size))
    assert abs(_room(sp, "Master")["w"] - 4.27) < 0.15 and abs(_room(sp, "Study")["w"] - 3.05) < 0.15
    assert not any(" is labelled " in w for w in sp["warnings"])


def test_image_without_model_still_builds_rooms():
    im = draw_plan(PLAN_A, DOORS_A)
    sp = spec.from_pixels(raster.read_plan_pixels(im), None)
    assert len(sp["rooms"]) == 4 and all(r["name"].startswith("Room") for r in sp["rooms"])
    assert any("12 m" in w for w in sp["warnings"])


def test_blank_image_is_an_error():
    with pytest.raises(ValueError):
        spec.from_pixels(raster.read_plan_pixels(Image.new("RGB", (400, 300), "white")), None)


# ---- text specs ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("text,expect", [
    ("studio 6×4 m with kitchenette and bathroom 2×2", {"Studio", "Bathroom"}),
    ("3LDK, 10 m × 8 m wall to wall, ceiling 2.4 m", {"LDK", "Bedroom 1", "Bedroom 2", "Bedroom 3", "Bath", "WC"}),
    ("2 bedroom apartment 12 x 9 m overall, living room, kitchen 3 x 3, bathroom", {"Living Room", "Kitchen", "Bathroom"}),
    ("one-bed flat 40 sqm with a 3 x 3.5 bedroom and a shower room", {"Bedroom", "Shower Room"}),
])
def test_text_specs(text, expect):
    sp = spec.from_text(text)
    names = {r["name"] for r in sp["rooms"]}
    assert expect <= names, names
    assert sp["source"] == "text"
    W = max(r["x"] + r["w"] for r in sp["rooms"])
    D = max(r["z"] + r["d"] for r in sp["rooms"])
    area = sum(r["w"] * r["d"] for r in sp["rooms"])
    assert abs(area - W * D) < 0.05 * W * D, "rooms tile the footprint with no gaps or overlaps"
    for r in sp["rooms"]:
        assert spec.MIN_ROOM_M <= r["w"] <= spec.MAX_ROOM_M and spec.MIN_ROOM_M <= r["d"] <= spec.MAX_ROOM_M
    for o in sp["openings"]:
        room = _room(sp, o["room"])
        assert o["offset_m"] + o["width_m"] <= spec.wall_length(room, o["wall"]) + 1e-6
    assert any(o["type"] == "door" for o in sp["openings"])


def test_text_dims_are_honoured():
    sp = spec.from_text("studio 6×4 m with kitchenette and bathroom 2×2")
    assert max(r["x"] + r["w"] for r in sp["rooms"]) == 6.0 and max(r["z"] + r["d"] for r in sp["rooms"]) == 4.0
    bath = _room(sp, "Bathroom")
    assert (bath["w"], bath["d"]) == (2.0, 2.0)
    assert any(f["kind"] == "kitchen_counter" and f["room"] == "Studio" for f in sp["fixtures"])
    assert spec.from_text("3LDK 10 x 8 m wall to wall, ceiling 2.7 m")["ceiling_m"] == 2.7


def test_parse_dims_units():
    assert spec.parse_dims("5.4 x 6.0") == (5.4, 6.0)
    assert spec.parse_dims("3600 x 4200") == (3.6, 4.2)
    a, b = spec.parse_dims("12' x 10'6\"")
    assert abs(a - 3.6576) < 1e-3 and abs(b - 3.2004) < 1e-3
    assert spec.parse_dims("6 x 4 m") == (6.0, 4.0)
    assert spec.parse_dims("no numbers") is None


# ---- route -----------------------------------------------------------------------------------------


def test_route_text_and_image(tmp_path, monkeypatch):
    web = pytest.importorskip("aiohttp.web")
    aiohttp = pytest.importorskip("aiohttp")
    im = draw_plan(PLAN_A, DOORS_A)
    im.save(tmp_path / "plan.png")
    monkeypatch.setattr(routes, "_input_dir", lambda: str(tmp_path))
    monkeypatch.setattr(routes, "image_path", lambda name: str(tmp_path / name))
    monkeypatch.setattr(routes.vlm, "available_model", lambda: "qwen3.5_4b_bf16.safetensors")

    async def fake_read(base, name, model, timeout_s=300.0):
        return fake_vlm(PLAN_A, im.size), {"vlm_total_ms": 1, "vlm_exec_ms": 1, "queue_wait_ms": 0}
    monkeypatch.setattr(routes.vlm, "read_with_vlm", fake_read)

    async def main():
        table = web.RouteTableDef()
        routes.register(table)
        app = web.Application()
        app.add_routes(table)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        base = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(base + "/soundstage/plan", json={"text": "studio 6x4 m, bathroom 2x2"}) as r:
                    d = await r.json()
                    assert r.status == 200 and d["source"] == "text" and d["reader"] == "rules"
                async with s.post(base + "/soundstage/plan", json={"image": "plan.png"}) as r:
                    d = await r.json()
                    assert r.status == 200 and d["source"] == "image", d
                    assert any("Hall is labelled" in w for w in d["warnings"])
                    assert d["reader"].startswith("pixels + qwen")
                import base64
                import io
                buf = io.BytesIO()
                im.save(buf, "PNG")
                url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
                async with s.post(base + "/soundstage/plan", json={"image": url, "vlm": False}) as r:
                    d = await r.json()
                    assert r.status == 200 and d["image"].startswith("ss_plan_") and d["reader"] == "pixels only"
                async with s.post(base + "/soundstage/plan", json={}) as r:
                    assert r.status == 400
        finally:
            await runner.cleanup()

    asyncio.run(main())


def test_vlm_reply_parsing():
    from soundstage.floorplan.vlm import parse_reply
    txt = '```json\n{"rooms": [{"name": "LDK", "label": "LDK\\n5.4 x 6.0", "bbox_px": [0, 0, 500, 1000]}]}\n```'
    assert parse_reply(txt)["rooms"][0]["name"] == "LDK"
    bare = '```json\n[{"name": "Hall", "label": "1.2 x 1.2", "bbox_px": [680, 360, 880, 600]}]\n```'
    assert parse_reply(bare)["rooms"][0]["label"] == "1.2 x 1.2"
    with pytest.raises(ValueError):
        parse_reply("I see a kitchen.")


def test_fixtures_do_not_overlap():
    for text in ("3LDK, 10 m × 8 m wall to wall", "studio 6×4 m with kitchenette and bathroom 2×2"):
        sp = spec.from_text(text)
        sizes = {k: (w, d) for items in spec.FURNISH.values() for k, w, d, _ in items}
        boxes = []
        for f in sp["fixtures"]:
            w, d = sizes[f["kind"]]
            if f["rotation_deg"] in (90, 270):
                w, d = d, w
            boxes.append((f, f["x"] - w / 2, f["z"] - d / 2, f["x"] + w / 2, f["z"] + d / 2))
            room = _room(sp, f["room"])
            assert room["x"] <= f["x"] - w / 2 + 1e-6 and f["x"] + w / 2 <= room["x"] + room["w"] + 1e-6, f
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                if a[0]["kind"] in ("rug",) or b[0]["kind"] in ("rug",):
                    continue
                overlap = min(a[3], b[3]) - max(a[1], b[1]) > 0.01 and min(a[4], b[4]) - max(a[2], b[2]) > 0.01
                assert not overlap, (a[0], b[0])


@pytest.mark.parametrize("text,room,size", [
    ("two-bedroom apartment, living room 5x4, kitchen 3x3, bedroom 4x3.5, bathroom 2x2.5", "Living Room", {4.0, 5.0}),
    ("two-bedroom apartment, living room 5x4, kitchen 3x3, bedroom 4x3.5, bathroom 2x2.5", "Bedroom", {3.5, 4.0}),
    ("apartment with a 6x5 living room, kitchen 3x4 and two bedrooms", "Living Room", {5.0, 6.0}),
    ("loft with a 8x6 living room and a 3x3 bedroom", "Bedroom", {3.0}),
    ("one-bed flat 40 sqm with a 3 x 3.5 bedroom and a shower room", "Bedroom", {3.0, 3.5}),
])
def test_stated_room_sizes_are_kept_without_an_overall_size(text, room, size):
    """A guessed footprint used to squeeze a 'living room 5x4' into a 2.4 x 6.9 m strip."""
    sp = spec.from_text(text)
    r = _room(sp, room)
    assert {r["w"], r["d"]} == size, (r, sp["warnings"])
    W = max(q["x"] + q["w"] for q in sp["rooms"])
    D = max(q["z"] + q["d"] for q in sp["rooms"])
    assert abs(sum(q["w"] * q["d"] for q in sp["rooms"]) - W * D) < 0.05 * W * D, "rooms still tile the footprint"


def test_parse_reply_survives_an_unclosed_outer_list():
    """Real qwen3.5-4b reply (2026-10-28): it wrapped the object in a list and never closed the list."""
    from soundstage.floorplan.vlm import parse_reply
    reply = ('```json\n[\n\t{\n\t\t"rooms": [\n\t\t\t{"name": "Living Room", "label": "7.0 x 4.0 m", "bbox_px": [0, 0, 700, 350]},'
             '\n\t\t\t{"name": "Kitchen", "label": "3.0 x 3.0 m", "bbox_px": [0, 350, 200, 700]}\n\t\t]\n\t}\n```')
    rooms = parse_reply(reply)["rooms"]
    assert [(r["name"], r["label"]) for r in rooms] == [("Living Room", "7.0 x 4.0 m"), ("Kitchen", "3.0 x 3.0 m")]
    closed = '[{"rooms": [{"name": "Hall", "label": "", "bbox_px": [0, 0, 10, 10]}]}]'
    assert parse_reply(closed)["rooms"][0]["name"] == "Hall"
