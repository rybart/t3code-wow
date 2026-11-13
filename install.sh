#!/bin/bash
# Install or update Orca for World of Warcraft.
#
#   curl -fsSL https://raw.githubusercontent.com/rybart/t3code-wow/orca-adapter/install.sh | bash
#
# Run the same command again to update. From a clone, ./install.sh installs that copy.
# Options (after `bash -s --` when piping): --wow "/path/to/World of Warcraft" --slots N --no-service
#
# Copies the bridge and addon to ~/.local/share/orca-wow, puts `orca-wow` on your
# PATH, then runs `orca-wow install`, which installs the addon into the game, gives
# the bridge what it needs to reach Orca, starts it as a user service and walks you
# through the first launch.
set -euo pipefail

repo="rybart/t3code-wow"
ref="${ORCA_WOW_REF:-orca-adapter}"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/orca-wow"
bin="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  if [[ $(uname -s) == "Darwin" ]]; then
    echo "T3 Code for World of Warcraft needs Node.js 22 or newer: brew install node (or mise use -g node@lts)." >&2
  else
    echo "T3 Code for World of Warcraft needs Node.js 22 or newer: mise use -g node@lts (or pacman -S nodejs)." >&2
  fi
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 22 )); then
  echo "T3 Code for World of Warcraft needs Node.js 22 or newer; found $(node --version)." >&2
  exit 1
fi

# KDE Plasma doesn't need grim: the bridge reads the game through KWin's D-Bus API.
if [[ ${XDG_SESSION_TYPE:-} == "wayland" && :${XDG_CURRENT_DESKTOP:-}: != *:KDE:* ]] && ! command -v grim >/dev/null 2>&1; then
  echo "Note: install grim so the bridge can see the game (pacman -S grim)." >&2
fi

# Install from this checkout, or download the latest version when piped from curl.
src=""
here="${BASH_SOURCE[0]:-}"
if [[ -n $here && -f $here ]]; then
  here="$(cd "$(dirname "$here")" && pwd)"
  if [[ -d "$here/bridge" && -d "$here/addon" ]]; then
    src="$here"
  fi
fi
if [[ -z $src ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading T3 Code for World of Warcraft ($ref)…"
  url="${ORCA_WOW_TARBALL:-https://codeload.github.com/$repo/tar.gz/$ref}"
  if ! curl -fsSL "$url" | tar -xz -C "$tmp" --strip-components=1; then
    echo "Couldn't download $url." >&2
    exit 1
  fi
  src="$tmp"
fi

# Before the rename to orca-wow this was t3code-wow: stop that service and move its
# folders (settings, the link key, saved state, the WoW Assistant's workspace) across.
old_data="${XDG_DATA_HOME:-$HOME/.local/share}/t3code-wow"
if [[ -d $old_data || -L $bin/t3code-wow ]]; then
  if [[ $(uname -s) == "Darwin" ]]; then
    launchctl bootout "gui/$(id -u)/t3code-wow" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/t3code-wow.plist"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now t3code-wow.service 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/t3code-wow.service"
  fi
  for pair in "${XDG_DATA_HOME:-$HOME/.local/share}" "${XDG_STATE_HOME:-$HOME/.local/state}" "${XDG_CONFIG_HOME:-$HOME/.config}"; do
    if [[ -d $pair/t3code-wow && ! -e $pair/orca-wow ]]; then mv "$pair/t3code-wow" "$pair/orca-wow"; fi
  done
  rm -f "$bin/t3code-wow"
  echo "Moved the old t3code-wow install to orca-wow."
fi

mkdir -p "$dest" "$bin"
rm -rf "$dest/bridge.new" "$dest/addon.new"
cp -r "$src/bridge" "$dest/bridge.new"
cp -r "$src/addon" "$dest/addon.new"
rm -rf "$dest/bridge" "$dest/addon"
mv "$dest/bridge.new" "$dest/bridge"
mv "$dest/addon.new" "$dest/addon"
chmod +x "$dest/bridge/bin/orca-wow.js"
ln -sf "$dest/bridge/bin/orca-wow.js" "$bin/orca-wow"
if [[ ":$PATH:" != *":$bin:"* ]]; then
  echo "Note: $bin isn't on your PATH, so run orca-wow as $bin/orca-wow (or add $bin to PATH in your shell profile)." >&2
fi

# When piped from curl, stdin is this script; give the guided setup the keyboard.
if [[ ! -t 0 ]] && (: </dev/tty) 2>/dev/null; then
  node "$dest/bridge/bin/orca-wow.js" install "$@" </dev/tty
else
  node "$dest/bridge/bin/orca-wow.js" install "$@"
fi
