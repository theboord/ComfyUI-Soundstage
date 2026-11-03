# Runs inside UnrealEditor-Cmd -run=pythonscript: new level, run the kit's build_unreal.py, save, report.
import os, json, unreal
kit = os.environ["SOUNDSTAGE_KIT"]
out = os.environ["SS_UE_REPORT"]
level = "/Game/SS_Interop/L_KitTest"
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
ok_new = les.new_level(level)
unreal.log("SSREPORT new_level %s" % ok_new)
script = os.path.join(kit, "unreal", "build_unreal.py")
g = {"__file__": script, "__name__": "__main__"}
exec(compile(open(script).read(), script, "exec"), g)
saved = les.save_current_level()
unreal.EditorAssetLibrary.save_directory("/Game/", only_if_is_dirty=False, recursive=True)
acts = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
from collections import Counter
rep = {"new_level": bool(ok_new), "saved": bool(saved), "actors": len(acts), "by_class": dict(Counter(a.get_class().get_name() for a in acts)),
       "labels_sample": sorted(a.get_actor_label() for a in acts)[:40],
       "assets": [str(p) for p in unreal.EditorAssetLibrary.list_assets("/Game/", recursive=True)][:400]}
json.dump(rep, open(out, "w"), indent=1)
unreal.log("SSREPORT done %d actors" % len(acts))
