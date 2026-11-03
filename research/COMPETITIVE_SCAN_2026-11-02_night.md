# Competitive scan, night pass: #OpenSourceHiggsfield, 2026-11-02 → 03

Research only, for Mike and the lead session. Nothing here changes Soundstage, and nothing was posted. It adds to `research/competitive_scan_2026-11-02.md` and covers only what that scan missed or what changed since.

## TL;DR (10 lines)

1. **No winners yet.** The official page reportedly says the window closes **Tue Nov 3, 9:00 AM PT** and winners come **Nov 10**. Third-party coverage says Nov 6. Our 9 AM post lands right on the close, so **post a few minutes early**.
2. **MiniMax H3 is not required to enter.** "H3 must be the core model" is the rule for the **MiniMax bonus** only. Soundstage (LTX-core, H3 optional) should not claim that bonus.
3. **Name our category in the copy:** "Open Weights Only" (no partner nodes, no closed APIs), plus the LTX and FLUX model bonuses. Terraformer-3D already names its category in its README.
4. **Comfy ran a NYC Build Night on Nov 2** (The Yard, Herald Square). It brought a wave of small new repos (Anime News, Storyboard Studio, chameleon.ai, Dream Life). Most run on Comfy Router or mock mode. None comes close to our depth.
5. **The new entries that matter:** Opsis (an Apache-2.0 "AI film studio" with **3D blocking in splat worlds**), Henge (MIT, H3 swap and motion transfer with **its own trained LoRAs**), Terraformer-3D (MIT, greybox → **Unreal 5.8** city, 1,119 tests) and Chucksi/Massless (MIT, a **free live website**, with camera moves running on the visitor's device).
6. **"AI film studio" is now a crowded label** (Opsis, Haggs, Wind Comic, Nightshift, Anime News). Lead with what only we have: **physics, stunts and planted-feet actors on a real 3D set that the video obeys.**
7. **Video packaging bar:** Henge ships a 1:58 cut, a 4:04 full cut and a **50-second reel** as release MP4s linked from the README. Copy that: one ≤2-min commercial plus one ≤50 s reel.
8. **Credibility hooks to add in under an hour:** a "Tested on" hardware line, a test-count line (we have **934 Python test functions**) and a short **Known issues** section. Terraformer uses all three.
9. **Quick features (≤2 h):** an install `preflight` that checks models and nodes (we have none; our "doctor" is the script doctor), a Crash zoom camera preset, and a loudness (LUFS) line in the NLE export report.
10. **Couldn't verify:** comfy.org, luma.com and explainx.ai are blocked from this session; there's no X hashtag timeline, no Reddit, and no star history. Dates and rules come from search snippets. **Check the official page before posting.**

---

## How this pass was done, and its limits

- **GitHub:** repository search for "higgsfield" and "OpenSourceHiggsfield" created or pushed since 2026-10-31, plus the topic `open-source-higgsfield`. I diffed the results against the earlier scan by name. For the six most relevant new entries I read the README and LICENSE as raw files from the default branch. The GitHub repo API is closed to this session (403), so star counts come from search results, read at about 03:00 UTC on Nov 3.
- **Web:** search results only. comfy.org, luma.com and explainx.ai would not resolve, as the session's network policy blocks them, so I could not read the official rules, the NYC event page or the cease-and-desist write-up. Statements about rules and dates below are **search-snippet level**, and the snippets disagree.
- **X, LinkedIn, YouTube, Reddit:** search returns individual posts and profiles, not a hashtag timeline. I found no Reddit threads. YouTube coverage was limited to demo links inside READMEs.
- **Features:** claims come from READMEs. I didn't run anything.

## What's new about the contest itself

| Item | What I found | Confidence |
|---|---|---|
| Deadline | The official page is quoted as "Submission window closes: November 3rd 9am PT"; older coverage says Oct 30 9am PT | Medium. Two snippets cite comfy.org for Nov 3 |
| Winners | "Nov 10" (attributed to comfy.org) vs "Nov 6" (comfyui-wiki, ArtRealm). Winners will be featured on comfy.org/hub with credit | Low |
| Categories | $10k Best Overall; RTX 5090s for **Most Innovative**, **Most Viral** and **Open Weights Only**; bonuses from LTX, FLUX and MiniMax; $250 Comfy credits for 10 runners-up (Digg). An entry can win one main category plus one model bonus | Medium |
| MiniMax bonus | "MiniMax H3 must be the core model in the workflow to qualify" ($1,000 in MiniMax API credits) | Medium |
| Platform | Entries must be built on the Comfy Developer Platform (Comfy API, Comfy Router, Builds). We have `tools/soundstage_sdk.py` (Comfy SDK + comfy-api-proxy), so mention it in the post | Medium |
| Judges | A ComfyUI + NVIDIA + Runpod panel, with bonus categories judged by each model provider. **Caveat:** that text is from the earlier "Open Call" challenge post | Low |
| Events | LA Build Night on Oct 29 (with AI On The Lot); **NYC Build Night on Nov 2** at The Yard, Herald Square, with in-person awards | Medium |
| Name dispute | Higgsfield's cease-and-desist reportedly asks Comfy to stop using the name, hashtag and URL. Comfy says the challenge goes on. I found no rename | Medium |

## New or newly notable entries

Licence = the LICENSE file I read, unless marked "GitHub label". (a) = MIT, Apache-2.0 or BSD, so code is reusable with attribution. (b) = copyleft or unverified, so treat as idea only.

### 1. Opsis — sanchezrobertodev/opsis (Apache-2.0, (a)). Created Oct 6, pushed Nov 3.
- **What it does:** a self-hosted "open-source AI film studio" on ComfyUI, with Next.js 16 and Python 3.12. It runs Wan 2.2, LTX-2.5 and FLUX.2 klein locally or on your own RunPod endpoint. With API keys it adds 60+ hosted models (fal, Google, Runway, ElevenLabs), **each take priced before it runs**. Features: shot sequences continued from the last frame; edit, motion control (65 camera moves) and motion transfer; object and face swap; `@mention` characters with reference sheets and LoRA identities; Faceless Studio; Cinema Studio (script → storyboard → takes → timed cut, with an AI director chat and lip-sync); **3D blocking in Gaussian-splat worlds, re-rendered as live action**; dubbing; one-form templates.
- **Presentation:** a centred logo, badges and a "Launch film" made in the app, embedded at the top. Screenshots carry captions, and there is a feature table.
- **What it has that we lack:** hosted-model reach and a price on every take. Its launch film is made entirely with the product. Splat worlds as blocking sets (we import splats but don't block in them as worlds).
- **Threat:** it uses the same words as us ("AI film studio", "3D blocking"). Judges skimming will see two of them, so our copy must show the physics and stunts within one second.

### 2. Henge — alisson-anjos/Henge (MIT, (a); the LoRA weights are on HF under a licence I did not check). 61 stars, created Oct 17, pushed Nov 2.
- **What it does:** H3 character swap, motion transfer, head swap and sharpening from one guide video, run locally, on a RunPod pod or on **RunPod Serverless**. It ships **task-trained LoRAs** (Character Swap v1.1, Motion Transfer v1.0 / TARA / FFP, Head Swap, Sharpness, plus an H3 latent upscaler), all by the author. **TARA-H3** is a published reference-attention method with a technical report. SAM 3.1 marks subjects, and multi-character swaps carry across camera cuts. A studio assistant works through its own VLM, Claude or OpenAI-compatible models, or MCP. There is a first-run wizard, and you can export a shot **with its ComfyUI workflow and inputs**.
- **Presentation:** the best video packaging in the field. A **1:58 demo, a 4:04 full cut and a 50-second reel**, all as GitHub release MP4s, sit at the top of the README with a poster image, followed by guide-versus-result WebP pairs. It has a dated changelog.
- **What it has that we lack:** its own trained models with a research write-up ("Not just an interface"), serverless deployment, and multi-length demo cuts.
- **Note:** its showcase uses Tekken 8 fight footage. That is an IP risk for them; don't copy it.

### 3. Terraformer — hawkins-m/terraformer-3d (MIT, (a)). Created Oct 4, pushed Nov 3.
- **What it does:** a city layout goes in and a lit **Unreal Engine 5.8** scene comes out. The steps are a Blender greybox, then per-shot control passes, then FLUX.1-dev concept frames (fp8, ControlNet, Redux), then a VLM asset plan (Qwen3-VL 32B or 8B), then TRELLIS.2 and procedural assets, then UE placement and a look-matched light scene. It uses core ComfyUI nodes only, including SAM 3.1.
- **Presentation:** the README states its contest category: "**category Open Weights Only**". A YouTube demo is linked near the top. A command-line quick start (`ap setup`, `ap models download`, **`ap doctor`**, `ap ui`, `scripts/demo.sh starter`). An explicit "**Tested on**" line naming the hardware and versions, "**1,119 tests**" with the one known failing test named, a "Built during the challenge" section and "Known issues".
- **What it has that we lack:** an install doctor, a stated category, a tests-and-tested-on credibility block, and a UE 5.8 hand-off (we have DCC round trips, but check whether UE is among them before you claim it).

### 4. Chucksi (formerly Massless) — ChuckGPTX/massless (MIT, (a)). 31 stars, created Oct 30, live at chucksi.com.
- **What it does:** a free, no-account web studio. A shot designer (body, 8–135 mm lens, f/1.4–f/11, film stock) feeds FLUX.1 schnell on the Cloudflare Workers AI free tier or your own ComfyUI. **28 camera moves on a still** (dolly zoom, crash zoom, arcs, crane, rack focus, bullet time) are built from a Depth Anything V2 mesh **in the browser**, with the field of view tightened automatically so image edges never enter the frame. Effects such as LiDAR scan, Vanish and Clones; WebCodecs MP4. It also offers a Kokoro TTS voiceover, Whisper edit-by-text, a **LUFS / true-peak mastering report**, and image → splat or Idol 3D. An MCP and REST console.
- **Whether it's an entry:** the README mentions Higgsfield, but I could not confirm that it was submitted.
- **What it has that we lack:** a genuinely live, free try-it (real generation, capped per visitor). It sets the bar for "try it now": ours replays real renders.

### 5. Smaller new entries (new since Nov 1 unless noted)

| Entry | Licence | What it is | Worth noting |
|---|---|---|---|
| [iamnolanhu/anime-news](https://github.com/iamnolanhu/anime-news) (Nov 3, NYC Build Night) | MIT (a) | The hourly top headline becomes a 3-shot anime episode; Comfy Router FLUX 3 image → **FLUX 3 Video v2v continuation**, LTX 2.5 Fast or H3 picked per shot | **Mock mode by default** with a `MOCK MODE` / `LIVE` header badge, so the whole flow runs offline. Uses a closed router, so it isn't open-weights-only |
| [PxTicks/h3-motion](https://github.com/PxTicks/h3-motion) | AGPL-3.0 (b) | Pick a subject with SAM 3.1, remove it with Qwen Image 2.1, drag it along a keyframed path, then H3 Time-to-Move animates it with sound; or mask a video region and regenerate it | 86 stars. Pins an exact ComfyUI commit. Node pack ComfyUI-vlo (licence not checked) |
| [underworldhistory1-ctrl/minimax-h3-higgsfield](https://github.com/underworldhistory1-ctrl/minimax-h3-higgsfield) | MIT (a) | An H3 + Qwen Image 2.1 browser workspace; v2.8.1 with launcher, compatibility matrix and **preflight that lists missing downloads** | Its "Superman above Earth" demo uses DC IP; don't imitate it |
| [sintetizacom/easycomfee](https://github.com/sintetizacom/easycomfee) | MIT (a) | LTX-core one-prompt studio: day → night, **Blender blockout → film shot**, relight, cinemagraph, foley, SDR → HDR | Before/after GIF gallery "on a 16 GB GPU" |
| [hexeosis-prime/nightshift](https://github.com/hexeosis-prime/nightshift) | Apache-2.0 (GitHub label; LICENSE not read) (b) | Song (MiniMax Music 3) → Flux 2 Klein keyframes → LTX 2.3 lip-sync and camera moves → beat cut, grade and **lyric HUD that steers around faces**; runs overnight from MCP | Hook: "the night shift on your own GPU" |
| [DialloWill/storyboard-studio](https://github.com/DialloWill/storyboard-studio) (Build Night) | MIT (a) | A Cinema Studio rebuild for music-video storyboards | Mock only; the cloud generator is a stub |
| [ChrisChen667788/wind-comic](https://github.com/ChrisChen667788/wind-comic) | MIT (a) | Multi-agent, one-line → short drama (script, cast, storyboard, voice, timeline) | 707 stars, a "6887/6887 tests" badge, bilingual README. **Its entry status is unclear** |
| Andrew Peltekci, "One-take VFX" ([X post](https://x.com/apple_techie/status/2115988400557981807)) | MIT (per the post) | A phone clip plus an effect (fire, portal, neon wireframe, aurora) → LTX 2.5 in ComfyUI; built at LA Build Night | The post format: what it does, open weights, licence, repo, demo link, all in one tweet |
| Also new, not inspected | — | `ksamplermagazine/chameleon.ai` (Apache, Nov 3), `chenghishan/dream-life` (MIT, Nov 3), `thehananasif/Free-Higgsfield-AI` (no licence) and a dozen empty "higgsfield" repos | — |

### Momentum of known entries (stars, about Nov 3 03:00 UTC)

D3voz/openjutsu 1,284 · neuregex/freefield 760 (still pushing) · wexloops/openfield 128 · CreatorOS-Studio 48 · motion-previs-studio 30 · Kinoloom 22 · seam 21 · Soundstage 2. "Most Viral" is out of reach for us; aim for **Best Overall, Most Innovative and Open Weights Only**.

---

## Things we could still use before 9 AM PST, ranked

### (a) Copy and positioning

1. **Name the category on the first screen of the README and in post 7/7:** "Entering: Open Weights Only · eligible for the LTX and FLUX bonuses." Don't claim the MiniMax bonus, since H3 is optional for us. This costs 5 minutes and tells judges where to file us.
2. **Separate ourselves from the other "AI film studios" in the opening line.** Suggested README sub-line: *"Others give you a prompt box with a camera menu. Soundstage gives you a set: actors on planted feet, stunt cars on tyre physics, and a video model that has to follow them."* Our X main post already leads with physics, which is good; keep it there.
3. **Say the Comfy Developer Platform part out loud.** Name the headless Comfy SDK runner (`tools/soundstage_sdk.py`, comfy-sdk + comfy-api-proxy) in the Judging section and in the LinkedIn post, because entries must be built on that platform.
4. **Add a credibility block** like Terraformer's: "Tested on: RTX 6000 Ada 48 GB, ComfyUI \<version\>, \<OS\>" and "934 Python tests + JS tests: `python3 -m pytest -q`". Count the JS tests before you quote a total, and re-count the Python ones on the final commit.
5. **Add a short Known issues list**, three to five honest lines: 24 GB untested; Video → 3D is the basic version; the realism judge is strict on cars. Honesty reads as rigour, and Terraformer and Anime News both do it.
6. **Video packaging (Henge's model):** host the commercial as a GitHub release MP4 with a poster image at the top of the README, and post a **≤50 s reel** cut from it as the native X video. Keep the full walkthrough as the second link.
7. **A one-tweet format for replies or quote-posts** (the One-take VFX pattern): what it does → "100% open weights, MIT" → repo → demo. Our 7/7 already does most of this.
8. **Avoid copyrighted showcase footage and characters.** Two rivals use Tekken or Superman; our Western, car chase, horror and kaiju demos are original, so a short "all demo content is original" line costs nothing.

### (b) Quick features or polish (≤2 h each)

1. **`soundstage preflight`** (about 1–2 h): check ComfyUI's `/object_info` for our nodes and the model folders for every file listed in MODELS.md, and print what's missing with download links. Terraformer (`ap doctor`), H3 Higgsfield (launcher preflight) and others have one. Note: our existing "doctor" mentions are the screenplay doctor, not an install check. Write our own code; there's no need to lift anything.
2. **Crash zoom preset** (about 30–60 min) next to our dolly zoom. Chucksi, Anime News and Opsis all list it, and judges look for named moves. Check `cine_kb/movements.json` first.
3. **A loudness line in the NLE export report** (about 1 h): integrated LUFS and true peak of the mixed A1–A4, so "delivered at spec" includes sound. Chucksi's `loudness.js` is MIT if we want a reference; pyloudnorm (MIT) is simpler in Python.
4. **README hero video and poster** (about 30 min, once `[VIDEO]` exists). See (a)6.
5. **A Live / Replayed note in the post copy:** the README already has the badge. Add "(real renders, replayed)" next to the try-it link in 7/7 so no one expects live generation, since Chucksi's site is truly live.

### (c) Open-source nodes and models to integrate later

| What | Source | Licence | Why |
|---|---|---|---|
| Edge-safe depth-mesh camera moves on a still (FOV tightened so edges never show) and background refill behind depth cliffs | ChuckGPTX/massless | MIT (a) | A cheap preview of camera moves in ④ Frame without a video model |
| Edit-by-text cutting (Whisper words → keep ranges, cuts at the quietest 20 ms, 8 ms crossfades) | ChuckGPTX/massless (`textedit.js`) | MIT (a); Whisper large-v3-turbo is MIT | Dialogue trimming in the Cut |
| Mastering report and chain (BS.1770, true peak, a loudness-matched A/B) | ChuckGPTX/massless (`master.js`, `loudness.js`) | MIT (a) | Audio deliverables to spec |
| Idol image → 3D object | speridlabs (via Chucksi) | Apache-2.0 (per the Chucksi README; not checked at source) | An alternative to TripoSplat for props |
| H3 motion-transfer and character-swap LoRAs and the TARA-H3 method | alisson-anjos/Henge, HF `Alissonerdx/Minimax-H3-ComfyUI` | App MIT (a); **LoRA and ai-toolkit licences not checked**; H3 itself is under the MiniMax H3 Community Licence (region-limited, <$20M) | Better mocap-to-H3 performance transfer for our optional H3 engine |
| Splat worlds as blocking sets | sanchezrobertodev/opsis | Apache-2.0 (a); carry the NOTICE if there is one | Block inside a captured location |
| Greybox → Unreal 5.8 placement and light-matching | hawkins-m/terraformer-3d | MIT (a) | A UE hand-off from our stage (check our DCC list first) |
| Time-to-Move drag-to-animate | PxTicks/h3-motion + ComfyUI-vlo | AGPL-3.0 (b); vlo not checked | Idea only |
| Lyric HUD that avoids faces; fitting the shot list to the song | hexeosis-prime/nightshift | Apache-2.0 per GitHub label, LICENSE not read (b until checked) | A music-video template |

Attribution rules from the earlier scan still apply: MIT keeps its notice, Apache carries its NOTICE and marks changed files, add a row to `THIRD_PARTY_NOTICES.md`, and never copy AGPL or GPL code.

## What I could not verify

- The official rules, the deadline and the winner date (comfy.org blocked). Two snippets cite comfy.org for "Nov 3 9am PT" and "Nov 10", but I could not read the page myself.
- The NYC Build Night awards and their winners (luma.com blocked).
- X and LinkedIn posts since Nov 1 beyond the single post above. There was no hashtag timeline and nothing from Reddit.
- Whether Chucksi/Massless, Wind Comic, Opsis and EasyComfee were actually submitted. Their READMEs mention Higgsfield, but only Terraformer, Anime News, Storyboard Studio and H3 Motion state outright that they are entries.
- Weight licences for Henge's LoRAs, Idol and ComfyUI-vlo.
- Star counts are a single snapshot with no history.

## Sources

- Repos linked above (README and LICENSE read from raw default branches, Nov 3 ≈03:00 UTC)
- https://comfy.org/open-source-higgsfield/ (search snippets only)
- https://comfyui-wiki.com/en/news/2026-10-15-open-source-higgsfield
- https://digg.com/ai/9hu7yics
- https://artrealmai.com/article/higgsfield-cease-and-desist-comfyui-open-source-challenge
- https://blog.comfy.org/p/open-call-comfy-dev-platform-challenge (judging panel, earlier challenge)
- https://comfy.org/events/ (NYC Build Night, Nov 2)
- https://x.com/apple_techie/status/2115988400557981807
- https://x.com/ComfyUI/status/2115928993623109648
