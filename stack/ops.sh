#!/bin/bash
# ops.sh — quick maintenance helper for the agent stack
# Usage: ./ops.sh <command>
#   status       Overall stack status
#   logs <svc>   Tail logs for a service (caddy|dashboard|openwebui|n8n|nginx|ollama)
#   restart-all  Restart the full stack
#   update       Pull latest images and restart
#   backup       Run backup now
#   models       List installed Ollama models
#   pull <model> Pull an Ollama model with live progress
#   rm <model>   Remove an Ollama model
#   tailnet      Show tailnet status
#   throttle <d> <u>  Apply bandwidth throttle (Mbps down/up) — or `off`
#   thermal <pct>     Cap CPU max freq to pct% — or `off` / no-arg for status
set -e
cd "$(dirname "$0")"

cmd="${1:-status}"
case "$cmd" in
  status)
    echo "=== docker compose ==="
    docker compose ps
    echo ""
    echo "=== ollama ==="
    systemctl is-active ollama || true
    ollama list 2>/dev/null || echo "not reachable"
    echo ""
    echo "=== tailnet ==="
    tailscale ip -4 2>/dev/null || echo "tailscale down"
    echo ""
    echo "=== disk ==="
    df -h / /home | tail -2
    echo ""
    echo "=== memory ==="
    free -h | head -2
    ;;
  logs)
    svc="${2:-}"
    if [ "$svc" = "ollama" ]; then
      journalctl -u ollama -n 80 --no-pager
    else
      docker compose logs --tail 80 "$svc"
    fi
    ;;
  restart-all)
    docker compose restart
    ;;
  update)
    docker compose pull
    docker compose up -d --build
    ;;
  backup)
    ./backup.sh
    ;;
  models)
    ollama list
    ;;
  pull)
    shift
    ollama pull "$@"
    ;;
  rm)
    shift
    ollama rm "$@"
    ;;
  tailnet)
    tailscale status
    echo ""
    sudo tailscale serve status
    ;;
  throttle)
    if [ "$2" = "off" ]; then
      sudo /usr/local/bin/net-throttle off
    else
      sudo /usr/local/bin/net-throttle "${2:-5}" "${3:-2}"
    fi
    ;;
  thermal)
    sudo /usr/local/bin/cpu-throttle "${2:-status}"
    ;;
  *)
    echo "unknown command: $cmd"
    grep '^#   ' "$0" | head -20
    exit 1
    ;;
esac
