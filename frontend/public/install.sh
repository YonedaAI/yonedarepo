#!/bin/sh
# Installs the YonedaRepo CLI: yoneda and its Git helper git-remote-yoneda.
#
#   curl -fsSL https://yonedarepo.com/install.sh | sh
#
# Downloads the prebuilt binaries for this machine (macOS or Linux, arm64 or x86-64) from
# the site's /downloads, checks the archive against the release's SHA256SUMS, and only
# then installs both programs into ~/.local/bin. Nothing runs as root.
#
# Environment:
#   YONEDA_INSTALL_DIR     where to install (default ~/.local/bin)
#   YONEDA_VERSION         a release to install (default the latest)
#   YONEDA_TARGET          darwin-arm64, darwin-x64, linux-x64 or linux-arm64 (default: detected)
#   YONEDA_DOWNLOAD_BASE   the site to download from (default the one serving this script)
set -eu

site="${YONEDA_DOWNLOAD_BASE:-__YONEDA_SITE__}"
dir="${YONEDA_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'yoneda install: %s\n' "$1" >&2
  exit 1
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
  *) fail "no prebuilt yoneda for $target; build it from source with cargo" ;;
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

archive="yoneda-$version-$target.tar.gz"
release="$site/downloads/cli/$version"
fetch "$release/$archive" "$tmp/$archive" || fail "could not download $release/$archive"
fetch "$release/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $release/SHA256SUMS"
expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list $archive"
actual=$(digest "$tmp/$archive")
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"

mkdir "$tmp/unpacked"
tar -xzf "$tmp/$archive" -C "$tmp/unpacked"
for program in yoneda git-remote-yoneda; do
  [ -f "$tmp/unpacked/$program" ] || fail "$archive has no $program"
done
mkdir -p "$dir"
# Each program is copied beside its final name and moved over it, so a running copy is
# never left half written.
for program in yoneda git-remote-yoneda; do
  cp "$tmp/unpacked/$program" "$dir/.$program.new"
  chmod 755 "$dir/.$program.new"
  mv -f "$dir/.$program.new" "$dir/$program"
done

printf 'Installed yoneda %s (%s) in %s\n' "$version" "$target" "$dir"
# shellcheck disable=SC2016 # $PATH is printed for the reader to paste, not expanded.
case ":$PATH:" in
  *":$dir:"*) ;;
  *) printf 'Add it to your PATH, for example: export PATH="%s:$PATH"\n' "$dir" ;;
esac
printf 'Next: yoneda login\n'
