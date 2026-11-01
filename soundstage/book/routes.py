"""HTTP routes for the Director's Book (Milestone 23). register() is idempotent; __init__.py mounts it.

GET  /soundstage/book/info                                  -> {model, available}
POST /soundstage/book/prompt  {mode: draft|place|spine, script, scene_id?, stage?, notes?} -> {system, prompt, max_length, model}
POST /soundstage/book/draft   {script, scene_id, llm_text}  -> {sections, grounding, backend}
POST /soundstage/book/spine   {script, llm_text}            -> {spine, statement, grounding}
POST /soundstage/book/place   {script, notes, llm_text?}    -> {placements, backend}
GET  /soundstage/book                                       -> the stored book (404 if none)
POST /soundstage/book/save    {book}                        -> {ok, path}
GET  /soundstage/book/context?scene=sc_1                    -> book_context() of the stored book
POST /soundstage/book/note    {text, scene_id?, category?, source?, script?} -> {note}; the open App merges it
"""
from __future__ import annotations

_REGISTERED = False
EVENT = "soundstage.book"


def register(routes=None, send=None) -> bool:
    global _REGISTERED
    if _REGISTERED and routes is None:
        return False
    from aiohttp import web

    from ..agent import prompts as PR
    from . import context as CX
    from . import draft as DR
    from . import place as PL
    from . import store as ST

    if routes is None:
        from server import PromptServer
        routes = PromptServer.instance.routes

    def _server_send(ev, data):
        try:
            from server import PromptServer
            PromptServer.instance.send_sync(ev, data)
        except Exception:  # noqa: BLE001
            pass
    send = send or _server_send

    def _available() -> bool:
        try:
            import folder_paths
            return PR.MODEL in (folder_paths.get_filename_list("text_encoders") or [])
        except Exception:  # noqa: BLE001
            return False

    async def _body(request) -> dict:
        try:
            b = await request.json()
            return b if isinstance(b, dict) else {}
        except Exception:  # noqa: BLE001
            return {}

    def _script(b):
        s = b.get("script")
        return s if isinstance(s, dict) else {}

    @routes.get("/soundstage/book/info")
    async def info(request):
        return web.json_response({"model": PR.MODEL, "available": _available()})

    @routes.post("/soundstage/book/prompt")
    async def prompt(request):
        b = await _body(request)
        mode = b.get("mode")
        if mode == "place":
            p = PL.prompt(b.get("notes") or [], _script(b))
        elif mode == "spine":
            p = DR.spine_prompt(_script(b))
        else:
            p = DR.prompt(_script(b), str(b.get("scene_id", "")), b.get("stage") or {})
        p["model"] = PR.MODEL
        return web.json_response(p)

    @routes.post("/soundstage/book/draft")
    async def draft(request):
        b = await _body(request)
        return web.json_response(DR.parse(b.get("llm_text"), _script(b), str(b.get("scene_id", ""))))

    @routes.post("/soundstage/book/spine")
    async def spine(request):
        b = await _body(request)
        return web.json_response(DR.parse_spine(b.get("llm_text"), _script(b)))

    @routes.post("/soundstage/book/place")
    async def place(request):
        b = await _body(request)
        return web.json_response(PL.place(b.get("notes") or [], _script(b), b.get("llm_text")))

    @routes.get("/soundstage/book")
    async def get_book(request):
        bk = ST.load()
        return web.json_response(bk) if bk else web.json_response({"error": "no book saved yet"}, status=404)

    @routes.post("/soundstage/book/save")
    async def save(request):
        b = await _body(request)
        if not isinstance(b.get("book"), dict):
            return web.json_response({"error": "send {book}"}, status=400)
        return web.json_response({"ok": True, "path": ST.save(b["book"])})

    @routes.get("/soundstage/book/context")
    async def context(request):
        bk = ST.load() or {}
        return web.json_response(CX.book_context(bk, request.query.get("scene") or None, bk.get("script") if isinstance(bk.get("script"), dict) else None))

    @routes.post("/soundstage/book/note")
    async def note(request):
        b = await _body(request)
        t = str(b.get("text", "")).strip()
        if not t:
            return web.json_response({"error": "send {text}"}, status=400)
        n = {"text": t, "source": str(b.get("source") or "chat"), "by": str(b.get("source") or "chat")}
        script = _script(b)
        if b.get("scene_id"):
            n.update(scope="scene", scene_id=str(b["scene_id"]), category=str(b.get("category") or "blocking"),
                     confidence=1.0, why="written by the assistant for this scene")
        elif script:
            n.update(PL.place([t], script)["placements"][0])
            n["source"] = n["by"] = str(b.get("source") or "chat")
        else:
            n.update(scope="unsorted", category=str(b.get("category") or "blocking"), confidence=0.0, why="no script to place it in")
        stored = ST.add_note(n)
        send(EVENT, {"type": "note", "note": stored})
        return web.json_response({"note": stored})

    _REGISTERED = True
    return True
