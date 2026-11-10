#!/bin/sh
# Installs the YonedaRepo CLI: yoneda and its Git helper git-remote-yoneda, and cloudflared,
# which Git over SSH goes through (on Windows, install.ps1 does the same).
#
#   curl -fsSL https://yonedarepo.com/install.sh | sh
#
# Downloads the prebuilt binaries for this machine (macOS or Linux, arm64 or x86-64) from
# the site's /downloads, checks the archive against the release's SHA256SUMS, and only
# then installs all three programs into ~/.local/bin. cloudflared is Cloudflare's own release at
# the version pinned below, unless a working one is already on PATH. Without it HTTPS Git
# still works, so a failed download only warns. Then a line in your shell's start file puts
# the folder on PATH and another sets up completion, once each. Nothing runs as root.
#
# Environment:
#   YONEDA_INSTALL_DIR     where to install (default ~/.local/bin)
#   YONEDA_VERSION         a release to install (default the latest)
#   YONEDA_TARGET          darwin-arm64, darwin-x64, linux-x64 or linux-arm64 (default: detected)
#   YONEDA_DOWNLOAD_BASE   the site to download from (default the one serving this script)
#   YONEDA_NO_SHELL_SETUP  set to leave your shell's start file alone
set -eu

site="${YONEDA_DOWNLOAD_BASE:-__YONEDA_SITE__}"
dir="${YONEDA_INSTALL_DIR:-$HOME/.local/bin}"
cloudflared_version=2026.10.7
cloudflared_base=https://github.com/cloudflare/cloudflared/releases/download

fail() {
  printf 'yoneda install: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'yoneda install: %s\n' "$1" >&2
}

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --proto '=https,http' "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is needed to download"
fi
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is needed to check the download"
fi
command -v tar >/dev/null 2>&1 || fail "tar is needed to unpack the download"

# The target: YONEDA_TARGET, else this machine. A shell under Rosetta reports x86_64 on
# Apple silicon; the native arm64 build is the one to install there.
target="${YONEDA_TARGET:-}"
if [ -z "$target" ]; then
  os=$(uname -s)
  arch=$(uname -m)
  if [ "$os" = Darwin ] && [ "$arch" = x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  target="$os-$arch"
fi
case "$target" in
  darwin-arm64 | Darwin-arm64) target=darwin-arm64 ;;
  darwin-x64 | Darwin-x86_64) target=darwin-x64 ;;
  linux-x64 | Linux-x86_64 | Linux-amd64) target=linux-x64 ;;
  linux-arm64 | Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, run this in PowerShell: irm $site/install.ps1 | iex" ;;
  *) fail "no prebuilt yoneda for $target; build it from source with cargo" ;;
esac
printf 'Platform: %s\n' "$target"

# Each asset's SHA-256 at cloudflared_version, checked against the file itself (see
# docs/runbook.md for how to move the pin; install.ps1 pins the same version).
case "$target" in
  darwin-arm64)
    cloudflared_asset=cloudflared-darwin-arm64.tgz
    cloudflared_sum=3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd
    ;;
  darwin-x64)
    cloudflared_asset=cloudflared-darwin-amd64.tgz
    cloudflared_sum=02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848
    ;;
  linux-x64)
    cloudflared_asset=cloudflared-linux-amd64
    cloudflared_sum=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872
    ;;
  linux-arm64)
    cloudflared_asset=cloudflared-linux-arm64
    cloudflared_sum=3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

version="${YONEDA_VERSION:-}"
if [ -z "$version" ]; then
  fetch "$site/downloads/cli/LATEST" "$tmp/LATEST" || fail "could not read the latest version from $site"
  version=$(tr -d ' \r\n' <"$tmp/LATEST")
fi
case "$version" in
  '' | *[!0-9A-Za-z.+-]*) fail "unexpected version '$version'" ;;
esac

printf 'Version: %s\n' "$version"

archive="yoneda-$version-$target.tar.gz"
release="$site/downloads/cli/$version"
printf 'Downloading %s\n' "$archive"
fetch "$release/$archive" "$tmp/$archive" || fail "could not download $release/$archive"
fetch "$release/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $release/SHA256SUMS"
expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list $archive"
actual=$(digest "$tmp/$archive")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"
printf 'Checksum verified\n'

mkdir "$tmp/unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/unpacked"
for program in yoneda git-remote-yoneda yoneda-local; do
  [ -f "$tmp/unpacked/$program" ] || fail "$archive has no $program"
done
printf 'Installing to %s\n' "$dir"
mkdir -p "$dir"
# Each program is copied beside its final name and moved over it, so a running copy is
# never left half written.
for program in yoneda git-remote-yoneda yoneda-local; do
  cp "$tmp/unpacked/$program" "$dir/.$program.new"
  chmod 755 "$dir/.$program.new"
  mv -f "$dir/.$program.new" "$dir/$program"
done

# Copied in place like the programs above. Every failure warns and returns: yoneda itself
# is installed by now, and a download that fails its checksum is never unpacked or run.
install_cloudflared() {
  if cloudflared --version >/dev/null 2>&1; then
    printf 'cloudflared is already installed: %s\n' "$(command -v cloudflared)"
    return
  fi
  if "$dir/cloudflared" --version >/dev/null 2>&1; then
    printf 'cloudflared is already installed: %s\n' "$dir/cloudflared"
    return
  fi
  download="$tmp/$cloudflared_asset"
  if ! fetch "$cloudflared_base/$cloudflared_version/$cloudflared_asset" "$download"; then
    warn "could not download cloudflared; Git over SSH needs it, HTTPS Git works without it"
    return
  fi
  actual=$(digest "$download")
  if [ "$actual" != "$cloudflared_sum" ]; then
    rm -f "$download"
    warn "cloudflared checksum mismatch: expected $cloudflared_sum, got $actual; not installing it"
    return
  fi
  case "$cloudflared_asset" in
    *.tgz)
      if ! tar -xzf "$download" -C "$tmp/unpacked" cloudflared; then
        warn "could not unpack cloudflared; Git over SSH needs it, HTTPS Git works without it"
        return
      fi
      program="$tmp/unpacked/cloudflared"
      ;;
    *) program="$download" ;;
  esac
  cp "$program" "$dir/.cloudflared.new"
  chmod 755 "$dir/.cloudflared.new"
  mv -f "$dir/.cloudflared.new" "$dir/cloudflared"
  printf 'Installed cloudflared %s in %s\n' "$cloudflared_version" "$dir"
}

# The command to run next. Plain `yoneda login` goes to production; any other site names itself.
login_command() {
  case "$site" in
    https://yonedarepo.com) printf 'yoneda login\n' ;;
    https://*.yonedarepo.com) printf 'yoneda login --origin https://api.%s\n' "${site#https://}" ;;
    *) printf 'yoneda login --origin %s\n' "$site" ;;
  esac
}

# Adds a line to the shell's start file, unless it is there already. Goes through a group so a
# file that can't be written fails here, with one message from the caller, not the shell's own.
add_line() {
  if [ -f "$rc" ] && grep -Fqx -e "$1" "$rc" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$(dirname "$rc")" 2>/dev/null || return 1
  if ! { [ -f "$rc" ] && grep -Fqx -e "$marker" "$rc" 2>/dev/null; }; then
    { printf '\n%s\n' "$marker" >>"$rc"; } 2>/dev/null || return 1
  fi
  { printf '%s\n' "$1" >>"$rc"; } 2>/dev/null
}

# Which start file a new shell reads, and how it is spoken to there. `$HOME` stays a word in the
# file, so it still reads right if the home moves.
shell_setup() {
  marker='# Added by the YonedaRepo installer'
  home_dir="$dir"
  case "$dir" in
    "$HOME"/*) home_dir="\$HOME${dir#"$HOME"}" ;;
  esac
  kind=$(basename "${SHELL:-sh}")
  case "$kind" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      case "$target" in
        darwin-*) rc="$HOME/.bash_profile" ;;
        *) rc="$HOME/.bashrc" ;;
      esac
      ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/yoneda.fish" ;;
    *)
      rc="$HOME/.profile"
      kind=''
      ;;
  esac
  case "$kind" in
    fish)
      path_line="fish_add_path $home_dir"
      completion_line="yoneda completion fish | source"
      ;;
    *)
      path_line="export PATH=\"$home_dir:\$PATH\""
      completion_line="command -v yoneda >/dev/null && eval \"\$(yoneda completion $kind)\""
      ;;
  esac
  if [ "$on_path" = no ]; then
    if add_line "$path_line"; then
      printf 'PATH set in %s\n' "$rc"
    else
      warn "could not write $rc; add this line yourself: $path_line"
    fi
  fi
  # A release too old to print a script would fail in every new shell: no line for that.
  if [ -n "$kind" ] && "$dir/yoneda" completion "$kind" >/dev/null 2>&1; then
    if add_line "$completion_line"; then
      printf 'Shell completion set in %s\n' "$rc"
    else
      warn "could not write $rc; add this line yourself: $completion_line"
    fi
  fi
}

printf 'Installed yoneda %s (%s) in %s\n' "$version" "$target" "$dir"
install_cloudflared
on_path=yes
case ":$PATH:" in
  *":$dir:"*) ;;
  *) on_path=no ;;
esac
case "$dir" in
  *[\"\`\$\\]*) printf 'Add %s to your PATH\n' "$dir" ;;
  *)
    if [ -n "${YONEDA_NO_SHELL_SETUP:-}" ]; then
      [ "$on_path" = yes ] || printf 'Add %s to your PATH\n' "$dir"
    else
      shell_setup
    fi
    ;;
esac
if [ "$on_path" = yes ]; then
  printf 'Done\n'
else
  printf 'Done. Open a new terminal to use yoneda.\n'
fi
printf 'Next: %s\n' "$(login_command)"
