"""The grade half of the NLE package (soundstage/cut/export.py export_all adds these when the cut carries grades).

Project fields read (both optional; absent = no grade files, the package as before):
    shots[i].grade   {slope[3], offset[3], power[3], sat}   the shot's CDL (Takes -> Match to hero)
    colour.show      {cdl, curve?, name?}                    the show look (Look -> Steal the look)

Files, for a cut named <base>:
    <base>_grades.ccc         every graded clip's CDL in one ColorCorrectionCollection, id = the clip name
    <base>_<clip>.cdl         one ColorDecisionList per graded clip (Avid, Baselight, Resolve's "Apply CDL")
    <base>_<clip>.cube        33^3 LUT per graded clip: its CDL, then the show look (Resolve, Premiere Lumetri)
    <base>_show.cdl / .cube   the show look alone (CDL; the .cube adds its tone curve)
    GRADE.txt                 what goes where, the colour space, and the order

Mirrored by web/grade/grade.mjs gradeFiles(); keep the two in step (tests/test_grade.py compares them).
"""
from __future__ import annotations

import re

from .cdl import ccc_xml, cdl_xml, cube_text, is_identity, normalize_cdl, normalize_curve


def clip_id(name) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "clip")).strip("_") or "clip"


def shot_grade(shot):
    g = shot.get("grade")
    return None if not isinstance(g, dict) or is_identity(g) else normalize_cdl(g)


def show_look(project):
    s = (project.get("colour") or {}).get("show") if isinstance(project.get("colour"), dict) else None
    if not isinstance(s, dict):
        return None
    cdl, curve = normalize_cdl(s.get("cdl")), normalize_curve(s.get("curve"))
    if is_identity(cdl) and not curve:
        return None
    return {"cdl": cdl, "curve": curve, "name": str(s.get("name") or "Show look")}


def compose(shot_cdl, show):
    """The CDL list and curve for one clip's .cube."""
    cdls = [c for c in [shot_cdl, show["cdl"] if show else None] if c is not None]
    return cdls, (show["curve"] if show else None)


def grade_files(project, base) -> dict:
    """project: a normalised cut project. {} when nothing is graded."""
    show = show_look(project)
    graded, seen = [], set()
    for s in project.get("shots") or []:
        g = shot_grade(s)
        cid = clip_id(s.get("name") or s.get("id"))
        if g is None or cid in seen:
            continue
        seen.add(cid)
        graded.append({"id": cid, "cdl": g, "desc": str(s.get("grade", {}).get("note") or "")[:200]})
    if not graded and not show:
        return {}
    out = {}
    if graded:
        out[f"{base}_grades.ccc"] = ccc_xml(graded)
        for it in graded:
            out[f"{base}_{it['id']}.cdl"] = cdl_xml(it["id"], it["cdl"], it["desc"])
            cdls, curve = compose(it["cdl"], show)
            out[f"{base}_{it['id']}.cube"] = cube_text(cdls, curve, title=f"{it['id']} grade")
    if show:
        out[f"{base}_show.cdl"] = cdl_xml("show", show["cdl"], show["name"])
        out[f"{base}_show.cube"] = cube_text([show["cdl"]], show["curve"], title=show["name"])
    out["GRADE.txt"] = readme(base, graded, show)
    return out


def readme(base, graded, show) -> str:
    lines = [f"Soundstage grade: {base}", "",
             "Colour space: Rec.709 / sRGB display-encoded in and out (a Rec.709 timeline). The CDLs are ASC CDL v1.2",
             "(slope, offset, power, then saturation with Rec.709 luma weights); the .cube LUTs are 33x33x33.", ""]
    if graded:
        lines += [f"Per-clip grades ({len(graded)}): shot matching to the scene's hero take, in OKLab.",
                  f"  Avid Media Composer: the EDL carries *ASC_SOP / *ASC_SAT on each event; or import {base}_grades.ccc.",
                  f"  DaVinci Resolve: import the EDL with 'Use CDL from EDL', or Color > right-click a clip > Apply LUT > {base}_<clip>.cube.",
                  f"  Premiere Pro: Lumetri Color > Basic Correction > Input LUT > {base}_<clip>.cube.",
                  "  Each clip's .cube already includes the show look after its own CDL; the .cdl/.ccc are the clip's CDL only.", ""]
        lines += [f"  {g['id']}" for g in graded] + [""]
    if show:
        lines += [f"Show look: {show['name']}" + (" (CDL + tone curve)" if show["curve"] else " (CDL)"),
                  f"  {base}_show.cube on an adjustment layer / timeline node, or {base}_show.cdl where only a CDL fits",
                  "  (the .cdl cannot carry the tone curve)." if show["curve"] else "", ""]
    lines.append("Order in a node tree: clip CDL -> show look. Do not stack a clip .cube on top of the show .cube: it already has it.")
    return "\n".join(x for x in lines if x is not None) + "\n"
