#!/bin/bash
# install-thermal.sh — one-time setup for thermal safety on the server.
# Installs thermald (adaptive passive throttling) + a manual cpu-throttle helper
# + a watchdog that hard-caps CPU freq if the package exceeds 88°C.
# Safe to re-run; idempotent.
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "re-running under sudo..."
  exec sudo -E bash "$0" "$@"
fi

echo "[1/5] installing thermald + cpupower (via linux-tools) + lm-sensors..."
apt-get update -qq
KREL=$(uname -r)
apt-get install -y thermald lm-sensors linux-tools-common "linux-tools-${KREL}" linux-tools-generic >/dev/null || \
  apt-get install -y thermald lm-sensors linux-tools-common linux-tools-generic >/dev/null

echo "[2/5] enabling thermald (adaptive passive throttling)..."
systemctl enable --now thermald

echo "[3/5] writing /usr/local/bin/cpu-throttle..."
cat > /usr/local/bin/cpu-throttle <<'EOF'
#!/bin/bash
# cpu-throttle <pct|off>  — cap CPU max freq to <pct>% of hardware max.
#   cpu-throttle 70       # cap at 70% of max freq
#   cpu-throttle off      # restore full speed + ondemand governor
set -e
arg="${1:-status}"

max_khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq)
min_khz=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq)

case "$arg" in
  off)
    cpupower frequency-set -g ondemand >/dev/null
    cpupower frequency-set -u "${max_khz}" >/dev/null
    echo "throttle off — max ${max_khz} kHz, ondemand"
    ;;
  status)
    cur_gov=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)
    cur_max=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq)
    pct=$(( cur_max * 100 / max_khz ))
    temp=$(sensors 2>/dev/null | awk '/Package id 0:/ {print $4; exit}')
    echo "governor=${cur_gov}  max=${cur_max}kHz (${pct}% of hw max)  pkg_temp=${temp:-?}"
    ;;
  *)
    if ! [[ "$arg" =~ ^[0-9]+$ ]] || [ "$arg" -lt 20 ] || [ "$arg" -gt 100 ]; then
      echo "usage: cpu-throttle <20-100|off|status>" >&2
      exit 1
    fi
    new_max=$(( max_khz * arg / 100 ))
    if [ "$new_max" -lt "$min_khz" ]; then new_max=$min_khz; fi
    cpupower frequency-set -g powersave >/dev/null
    cpupower frequency-set -u "${new_max}" >/dev/null
    echo "throttle on — max ${new_max} kHz (${arg}% of hw max), powersave"
    ;;
esac
EOF
chmod +x /usr/local/bin/cpu-throttle

echo "[4/5] writing /usr/local/bin/thermal-watchdog..."
cat > /usr/local/bin/thermal-watchdog <<'EOF'
#!/bin/bash
# Polls Package temp every 10s. If >88°C for 3 consecutive reads, cap CPU to 60%.
# If <75°C for 6 consecutive reads after being capped, restore full speed.
set -e
HOT=88        # trigger threshold (°C)
COOL=75       # release threshold (°C)
HOT_HITS=3
COOL_HITS=6

hot=0
cool=0
capped=0

while :; do
  temp=$(sensors 2>/dev/null | awk '/Package id 0:/ {gsub(/[^0-9.]/,"",$4); print int($4); exit}')
  temp=${temp:-0}
  if [ "$temp" -ge "$HOT" ]; then
    hot=$((hot+1)); cool=0
    if [ "$hot" -ge "$HOT_HITS" ] && [ "$capped" -eq 0 ]; then
      /usr/local/bin/cpu-throttle 60 | logger -t thermal-watchdog
      capped=1
    fi
  elif [ "$temp" -le "$COOL" ]; then
    cool=$((cool+1)); hot=0
    if [ "$cool" -ge "$COOL_HITS" ] && [ "$capped" -eq 1 ]; then
      /usr/local/bin/cpu-throttle off | logger -t thermal-watchdog
      capped=0
    fi
  else
    hot=0; cool=0
  fi
  sleep 10
done
EOF
chmod +x /usr/local/bin/thermal-watchdog

cat > /etc/systemd/system/thermal-watchdog.service <<'EOF'
[Unit]
Description=Cap CPU max freq when package temp exceeds 88C
After=multi-user.target

[Service]
ExecStart=/usr/local/bin/thermal-watchdog
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "[5/5] enabling thermal-watchdog.service..."
systemctl daemon-reload
systemctl enable --now thermal-watchdog.service

echo ""
echo "done. current status:"
/usr/local/bin/cpu-throttle status
echo ""
echo "manual commands:"
echo "  ~/stack/ops.sh thermal 70    # cap CPU to 70%"
echo "  ~/stack/ops.sh thermal off   # remove cap"
echo "  ~/stack/ops.sh thermal       # show status"
