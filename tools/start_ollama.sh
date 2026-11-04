#!/usr/bin/env bash
# Start (installing first if missing) Ollama for ✦ Ask, the way Soundstage needs it. Safe to run on every boot:
#   bash tools/start_ollama.sh            # e.g. in a RunPod start command, before ComfyUI
# SKIP_OLLAMA=1 does nothing. ComfyUI also starts an installed Ollama itself when Soundstage loads.
# Models live in OLLAMA_MODELS (on RunPod: /workspace/ollama/models, the network volume, so pulls survive restarts;
# the binary is reinstalled by the official installer when a fresh pod lacks it).
set -euo pipefail
[ "${SKIP_OLLAMA:-0}" = "1" ] && { echo "SKIP_OLLAMA=1: no Ollama"; exit 0; }

if [ -z "${OLLAMA_MODELS:-}" ] && [ -d /workspace ]; then export OLLAMA_MODELS=/workspace/ollama/models; fi
[ -n "${OLLAMA_MODELS:-}" ] && mkdir -p "$OLLAMA_MODELS"
export OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:--1}"
# The App's origins (ComfyUI on 8188/8189 locally, RunPod's proxy). Ask normally goes through the ComfyUI server.
export OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-http://127.0.0.1:8188,http://127.0.0.1:8189,http://localhost:8188,http://localhost:8189,https://*.proxy.runpod.net}"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "== installing Ollama (official installer, MIT)"
  if [ "$(uname)" = "Darwin" ]; then
    echo "On a Mac, install the Ollama app from https://ollama.com/download (or: brew install ollama), then rerun."; exit 1
  fi
  curl -fsSL https://ollama.com/install.sh | sh
fi

if curl -fsS "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then echo "Ollama already running at $OLLAMA_HOST"; exit 0; fi
mkdir -p "${OLLAMA_MODELS:-$HOME/.ollama}"
nohup ollama serve >"${OLLAMA_MODELS:-$HOME/.ollama}/serve.log" 2>&1 &
for _ in $(seq 1 30); do curl -fsS "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1 && { echo "Ollama up at $OLLAMA_HOST"; exit 0; }; sleep 1; done
echo "Ollama didn't come up; see ${OLLAMA_MODELS:-$HOME/.ollama}/serve.log"; exit 1
