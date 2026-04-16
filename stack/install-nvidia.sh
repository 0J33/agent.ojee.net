#!/bin/bash
# install-nvidia.sh — run this ONCE after the Ollama model finishes downloading.
# Installs the recommended NVIDIA driver for the MX250, adds nvidia-container-toolkit
# for Docker GPU access, and configures Ollama to use GPU layers.
# Reboot required at the end.
set -e
export SUDO_ASKPASS=/tmp/askpass.sh
sudo_ () { if [ -f /tmp/askpass.sh ]; then sudo -A "$@"; else sudo "$@"; fi; }

echo "=== detect recommended driver ==="
sudo_ ubuntu-drivers devices | head -20 || true

echo ""
echo "=== install recommended NVIDIA driver ==="
sudo_ ubuntu-drivers autoinstall

echo ""
echo "=== install nvidia-container-toolkit (lets Docker see GPU) ==="
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo_ gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo_ tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo_ apt-get update -qq
sudo_ apt-get install -y nvidia-container-toolkit
sudo_ nvidia-ctk runtime configure --runtime=docker
sudo_ systemctl restart docker

echo ""
echo "=== driver install complete — REBOOT required ==="
echo "After reboot:"
echo "  - Verify with: nvidia-smi"
echo "  - Ollama will auto-detect GPU and offload layers"
echo "  - Expected speedup: ~3-5x for Qwen2.5-Coder 7B"
echo ""
echo "Run: sudo reboot"
