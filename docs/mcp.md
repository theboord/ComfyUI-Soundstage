# Soundstage over MCP: let Claude (or any MCP client) direct the set

Soundstage ships a small MCP server, `tools/soundstage_mcp.py`. It exposes the same typed tool layer as the
**Director** panel (the chat on the canvas), so Claude Desktop, Claude Code or any other MCP client can block a scene,
rig cameras, set up stunts and queue renders in the open App, while you watch it happen on the stage.

It is local: the server runs on your machine and talks HTTP to your own ComfyUI. Nothing goes anywhere else.
It uses the Python standard library only, so there is nothing to install.

## Propose, then apply

Every change is a **dry run first**. A tool call returns a plan in film language and a `plan_id`; nothing on the
set changes until the client calls `soundstage_apply(plan_id)`. When it does, the plan runs in the open App: it shows
up in the Director panel as a "Claude · MCP" turn, the stage changes in front of you, and **Undo this** (or
`soundstage_undo`) takes it back.

Anything that renders on the GPU (frames, drafts, finals) also needs `confirm_gpu: true` on the apply. A well-behaved
client asks you first. Without it, apply refuses and lists what it would have rendered.

```
soundstage_direct("put Mara in the sports car at night, rain, camera on the hood, she's nervous")
  -> Proposed (dry run, nothing changed yet). plan_id: 3f9c1a2b7e
     - put Mara in the sports car
     - move the clock to night (moonlight)
     - bring in rain
     - rig the camera on the sports car: hood view
     - note for Mara: nervous (it goes into the frame prompt)
soundstage_apply("3f9c1a2b7e")
  -> Applied in the App:
     - Mara is already in the sports car.
     - It's night: moonlight, the practicals carry the scene.
     - Rain on the set: wet streets that catch every light.
     - Camera rigged on the hood, looking back through the windscreen of the sports car: it rides with the car.
     - Noted for Mara: nervous. It's in the frame prompt, so the painted frame plays it.
```

## Tools

| Tool | What it does |
|---|---|
| `soundstage_state` | What's on the set now: set, time, weather, cast and objects, shots (numbered as in the shot strip), script scenes. |
| `soundstage_direct` | Plain words in, a proposed plan out (the same planner as the Director panel). |
| `soundstage_apply` | Run a proposed plan in the open App. `confirm_gpu: true` for renders. |
| `soundstage_undo` | Undo the last Director change. |
| `ss_<tool>` | One typed tool per App action (32 of them; 36 tools in all): `ss_add`, `ss_stack`, `ss_move`, `ss_remove`, `ss_turn`, `ss_scale`, `ss_time`, `ss_weather`, `ss_set`, `ss_light`, `ss_add_shot`, `ss_reframe`, `ss_mount`, `ss_dismount`, `ss_select_shot`, `ss_lens`, `ss_camera_move`, `ss_rig`, `ss_camera_on`, `ss_stunt`, `ss_drive`, `ss_physics`, `ss_bake`, `ss_direct`, `ss_grade`, `ss_scene`, `ss_frames`, `ss_render`, `ss_approve`, `ss_cut`, `ss_play`, `ss_build`. Each takes `dry_run` (default `true`: propose only; `false`: propose and apply). |

The typed tools carry a JSON schema (enums, ranges, required fields), and the server validates every call against
the live scene: names must be on the set, numbers stay in range (a lens is 8 to 400 mm), and a call that would break
the scene comes back as "couldn't: ..." instead of running.

## Set it up

1. Run ComfyUI with Soundstage, and **open the Soundstage App in a browser**. The App reports its scene to ComfyUI
   every couple of seconds and runs what you apply; with no App open, the tools say so.
2. Point the MCP server at that ComfyUI with `SOUNDSTAGE_URL` (default `http://127.0.0.1:8188`; an SSH tunnel to a
   GPU box works the same way).

**Claude Code**

```bash
claude mcp add soundstage -e SOUNDSTAGE_URL=http://127.0.0.1:8188 -- python3 /path/to/ComfyUI/custom_nodes/ComfyUI-Soundstage/tools/soundstage_mcp.py
```

**Claude Desktop** (`claude_desktop_config.json`: Settings > Developer > Edit Config)

```json
{
  "mcpServers": {
    "soundstage": {
      "command": "python3",
      "args": ["/path/to/ComfyUI/custom_nodes/ComfyUI-Soundstage/tools/soundstage_mcp.py"],
      "env": { "SOUNDSTAGE_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

Then ask Claude something like *"Look at my Soundstage set and make shot 2 a slow push-in at 50 mm"*. It reads the
state, proposes, shows you the plan and applies it.

## How it works

```
MCP client ──stdio──> tools/soundstage_mcp.py ──HTTP──> ComfyUI /soundstage/director/*
                                                          │  propose: plans against the scene the App reported (dry run)
                                                          │  apply:   websocket event "soundstage.director" to that App tab
                                                          ▼
                                      the open App (web/agent/directorpanel.mjs) runs the calls, posts the result back
```

Routes (`soundstage/agent/director_routes.py`): `POST /soundstage/director/state` (the App's report),
`GET /soundstage/director/state`, `POST /soundstage/director/propose` (`{command}` or `{calls}`),
`POST /soundstage/director/apply` (`{plan_id, confirm_gpu}`), `POST /soundstage/director/undo`. Only the App tab that
reported last runs an apply, so two open tabs never both act on it. Plans expire after an hour and run once.
