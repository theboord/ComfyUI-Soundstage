#!/usr/bin/env bash
# Install Soundstage, its node packs and the models the App needs into an existing ComfyUI.
#   bash tools/install_runpod.sh /workspace/ComfyUI            # everything (~60 GB of models)
#   SKIP_MODELS=1 bash tools/install_runpod.sh /workspace/ComfyUI
# Gated repos: accept the licenses on huggingface.co first, then `hf auth login` (or set HF_TOKEN).
# Licenses: LTX-2 Community (free < $10M revenue), Krea 2 Community (commercial < $1M revenue). See MODELS.md.
set -euo pipefail

COMFY="${1:?usage: install_runpod.sh /path/to/ComfyUI}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"
cd "$COMFY"

echo "== node packs"
mkdir -p custom_nodes
[ -e custom_nodes/ComfyUI-Soundstage ] || ln -s "$HERE" custom_nodes/ComfyUI-Soundstage
[ -d custom_nodes/ComfyUI-LTXVideo ] || git clone --depth 1 https://github.com/Lightricks/ComfyUI-LTXVideo custom_nodes/ComfyUI-LTXVideo
[ -d custom_nodes/comfyui-krea2-controlnet ] || git clone --depth 1 https://github.com/facok/comfyui-krea2-controlnet custom_nodes/comfyui-krea2-controlnet
"$PY" -m pip install -q -r "$HERE/requirements.txt"
[ -f custom_nodes/ComfyUI-LTXVideo/requirements.txt ] && "$PY" -m pip install -q -r custom_nodes/ComfyUI-LTXVideo/requirements.txt

echo "== workflow"
mkdir -p user/default/workflows
cp -n "$HERE/example_workflows/"Soundstage_*.json user/default/workflows/ 2>/dev/null || true

[ "${SKIP_MODELS:-0}" = "1" ] && { echo "SKIP_MODELS=1: done (see MODELS.md for the files)"; exit 0; }

"$PY" -m pip install -q "huggingface_hub[cli]>=0.30"
# get <repo> <file in repo> <models subfolder> [saved name]
get() {
  local repo="$1" file="$2" dir="models/$3" name="${4:-$(basename "$2")}"
  mkdir -p "$dir"
  if [ -s "$dir/$name" ]; then echo "   have $3/$name"; return; fi
  echo "   get  $3/$name"
  local tmp; tmp="$(mktemp -d)"
  hf download "$repo" "$file" --local-dir "$tmp" >/dev/null
  mv "$tmp/$file" "$dir/$name"; rm -rf "$tmp"
}

echo "== Krea 2 (look still)"
get Comfy-Org/Krea-2 diffusion_models/krea2_turbo_fp8_scaled.safetensors diffusion_models Krea-2-Turbo.safetensors
get Comfy-Org/Krea-2 text_encoders/qwen3vl_4b_fp8_scaled.safetensors text_encoders
get Comfy-Org/Krea-2 vae/qwen_image_vae.safetensors vae
get Patil/Krea-2-depth-controlnet depth-control-lora.safetensors loras/krea2/cn

echo "== LTX-2.5 (motion)"
get Lightricks/LTX-2.5 diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors diffusion_models
get Lightricks/LTX-2.5 text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors text_encoders
get Lightricks/LTX-2.5 vae/ltx-2.5-video-vae-bf16.safetensors vae
get Lightricks/LTX-2.5 vae/ltx-2.5-audio-vae-bf16.safetensors vae
get Lightricks/LTX-2.5 latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors latent_upscale_models
get Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors loras/ltx2.5

echo "== optional: object designer + scene agent (Qwen3.5 4B)"
[ "${SKIP_LLM:-0}" = "1" ] || get Comfy-Org/Qwen3.5 text_encoders/qwen3.5_4b_bf16.safetensors text_encoders

echo "Done. Start ComfyUI, open Workflows → Soundstage_App (graph view once, then App mode)."
