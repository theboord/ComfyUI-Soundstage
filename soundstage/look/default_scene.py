"""The stage's default walk-in scene (web/stage/stage.mjs DEFAULT_SCENE): a man and a woman walk across a
plaza into a building while the camera follows. tests/test_look_scene.py checks it still matches the JS."""

DEFAULT_SCENE = {
    "version": 2,
    "shot": {"frames": 97, "fps": 24},
    "camera": {"position": [-7.0, 1.7, -14.0], "target": [0, 1.3, -4.0], "focal_mm": 35},
    "camera_end": {"position": [-3.0, 1.7, -2.0], "target": [0, 1.3, 11.5], "focal_mm": 35},
    "sun": {"azimuth_deg": 235, "elevation_deg": 18},
    "environment": {"set": "plaza", "weather": "none", "density": 0.5, "water_level": 2.5},
    "lighting": {"mode": "manual", "hour": 17.6, "day_of_year": 300, "latitude": 34.05, "north_deg": 0,
                 "overcast": False, "preset": None, "lights": []},
    "actors": [
        {"id": "actor_a", "name": "Man", "kind": "man", "position": [-0.6, 0, -6], "position_end": [-0.6, 0, 12.5],
         "height_m": 1.78},
        {"id": "actor_b", "name": "Woman", "kind": "woman", "position": [0.6, 0, -6], "position_end": [0.6, 0, 12.5],
         "height_m": 1.68},
    ],
    "props": [
        {"id": "building", "kind": "building", "position": [0, 0, 15], "size": [21, 8, 9], "door": [3, 5]},
        {"id": "planter_l", "kind": "box", "position": [-3.5, 0, 6], "size": [1.2, 1.0, 1.2]},
        {"id": "planter_r", "kind": "box", "position": [3.5, 0, 6], "size": [1.2, 1.0, 1.2]},
        {"id": "lamp", "kind": "post", "position": [-8, 0, 2], "size": [0.15, 4, 0.15]},
    ],
}
