#!/usr/bin/env bash
# Explicit opt-in source installer helper, called only by install.sh --commission-shared-browser.
# Installs dedicated files and inert units; never discovers/edits OpenClaw config, starts or enables
# services, or touches existing browser profiles. Ordinary Portal updates never call it.
set -euo pipefail
shared_browser_install_source() {
  local portal_source="$1"
  [[ "$(id -u)" == 0 && "$portal_source" == /* ]] || return 77
  command -v Xtigervnc >/dev/null
  command -v xauth >/dev/null
  command -v nft >/dev/null
  if ! id bridgesbrowser >/dev/null 2>&1; then
    useradd --system --user-group --create-home --home-dir /home/bridgesbrowser --shell /usr/sbin/nologin bridgesbrowser
  fi
  [[ "$(getent passwd bridgesbrowser | cut -d: -f6)" == /home/bridgesbrowser && "$(id -u bridgesbrowser)" -gt 0 ]] || return 77
  local dedicated_path
  for dedicated_path in /home/bridgesbrowser /home/bridgesbrowser/.config /home/bridgesbrowser/.config/portal-shared /var/lib/bridges-shared-browser; do
    [[ ! -L "$dedicated_path" ]] || return 77
  done
  install -d -o bridgesbrowser -g bridgesbrowser -m 0700 /home/bridgesbrowser /home/bridgesbrowser/.config /home/bridgesbrowser/.config/portal-shared
  install -d -o root -g root -m 0700 /var/lib/bridges-shared-browser
  install -d -o root -g root -m 0755 /usr/local/lib/bridges-shared-browser
  install -m 0755 "$portal_source/static/scripts/bridges-shared-chrome.sh" /usr/local/bin/bridges-shared-chrome.sh
  install -m 0755 "$portal_source/static/scripts/bridges-shared-desktop-auth.py" /usr/local/lib/bridges-shared-browser/desktop-auth.py
  install -d -m 0755 /usr/local/lib/bridges-shared-browser/plugin
  install -m 0644 "$portal_source/installer/openclaw-shared-browser-plugin/"{index.js,package.json,openclaw.plugin.json} /usr/local/lib/bridges-shared-browser/plugin/
  cat > /etc/tmpfiles.d/bridges-shared-browser.conf <<'EOF'
d /run/bridges-shared-browser 0700 root root -
d /run/bridges-shared-desktop 0711 root root -
d /run/bridges-shared-desktop/transport 0700 bridgesbrowser bridgesbrowser -
EOF
  install -d -m 0755 /etc/bridges-shared-browser
  # Own table only: declare, delete and redefine it so a restart never duplicates rules
  # and never flushes unrelated host firewall state.
  cat > /etc/bridges-shared-browser/cdp.nft <<'EOF'
table inet bridges_shared_browser
delete table inet bridges_shared_browser
table inet bridges_shared_browser {
  chain output {
    type filter hook output priority -10; policy accept;
    ip daddr 127.0.0.1 tcp dport 18901 meta skuid != 0 reject
    ip6 daddr ::1 tcp dport 18901 meta skuid != 0 reject
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname != "lo" tcp dport 18901 drop
  }
}
EOF
  cat > /etc/systemd/system/bridges-shared-browser-cdp.service <<'EOF'
[Unit]
Description=Portal shared-browser root-only CDP policy
Before=bridges-shared-desktop.service bridges-shared-chrome.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/bridges-shared-browser/cdp.nft
# Policy remains fail-closed on service stop; never flush unrelated host firewall rules.
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/bridges-shared-desktop.service <<'EOF'
[Unit]
Description=Portal isolated shared-browser desktop (no TCP VNC or X11)
Requires=bridges-shared-browser-cdp.service
After=bridges-shared-browser-cdp.service systemd-tmpfiles-setup.service
[Service]
User=bridgesbrowser
Group=bridgesbrowser
UMask=0077
ExecStartPre=/usr/local/lib/bridges-shared-browser/desktop-auth.py
ExecStart=/usr/bin/Xtigervnc :2 -geometry 1440x900 -depth 24 -localhost -nolisten tcp -SecurityTypes None -rfbport -1 -rfbunixpath /run/bridges-shared-desktop/transport/vnc.sock -rfbunixmode 0600 -auth /run/bridges-shared-desktop/transport/Xauthority
Restart=on-failure
RestartPreventExitStatus=69 75 77
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/bridges-shared-chrome.service <<'EOF'
[Unit]
Description=Portal persistent interactive Shared Chrome
Requires=bridges-shared-desktop.service bridges-shared-browser-cdp.service
After=bridges-shared-desktop.service bridges-shared-browser-cdp.service
BindsTo=bridges-shared-desktop.service bridges-shared-browser-cdp.service
[Service]
User=bridgesbrowser
Group=bridgesbrowser
UMask=0077
Environment=HOME=/home/bridgesbrowser
ExecStart=/usr/local/bin/bridges-shared-chrome.sh
Restart=on-failure
RestartPreventExitStatus=69 75 77
[Install]
WantedBy=multi-user.target
EOF
}

# Close the legacy exec launchers (18801 Shared Chrome) only after the dedicated browser is live.
# Everyday/root/RDP Chrome and their profiles are unaffected; nothing is killed or deleted here.
shared_browser_retire_legacy_launchers() {
  [[ "$(id -u)" == 0 ]] || return 77
  install -m 0644 /dev/null /etc/bridges-shared-browser.enabled
}

# Explicit dedicated-profile reset only. Keep old data in a root-only archive; never import or wipe it.
# Parent coordinates stopped Portal broker/Gateway/browser before invoking this source helper.
shared_browser_archive_profile() {
  [[ "$(id -u)" == 0 ]] || return 77
  ! systemctl is-active --quiet bridges-shared-chrome.service || return 77
  ! systemctl is-active --quiet bridges-shared-desktop.service || return 77
  ! pgrep -u bridgesbrowser >/dev/null || return 77
  [[ ! -S /run/bridges-shared-browser/broker.sock && ! -e /run/bridges-shared-browser/inflight.json ]] || return 77
  local archive
  archive="$(mktemp -d /var/lib/bridges-shared-browser/retired.XXXXXXXX)"
  chmod 0700 "$archive"
  [[ ! -L /home/bridgesbrowser/.config/portal-shared/profile ]] || return 77
  if [[ -d /home/bridgesbrowser/.config/portal-shared/profile ]]; then
    mv -- /home/bridgesbrowser/.config/portal-shared/profile "$archive/profile"
  fi
  if [[ -f /var/lib/bridges-shared-browser/profile-owner.json ]]; then
    mv -- /var/lib/bridges-shared-browser/profile-owner.json "$archive/profile-owner.json"
  fi
}
