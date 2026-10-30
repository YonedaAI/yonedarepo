# Installs the YonedaRepo CLI on Windows: yoneda, its Git helper git-remote-yoneda, and
# cloudflared, which Git over SSH goes through (install.sh does the same on macOS and Linux).
#
#   irm https://yonedarepo.com/install.ps1 | iex
#
# Downloads the prebuilt binaries for this machine (x86-64 or arm64) from the site's
# /downloads, checks the archive against the release's SHA256SUMS, and only then installs both
# programs into %LOCALAPPDATA%\Programs\yoneda, which it adds to the user PATH. cloudflared is
# Cloudflare's own release at the version pinned below, unless a working one is already on
# PATH. Without it HTTPS Git still works, so a failed download only warns. No admin rights.
#
# Environment:
#   YONEDA_INSTALL_DIR     where to install (default %LOCALAPPDATA%\Programs\yoneda)
#   YONEDA_VERSION         a release to install (default the latest)
#   YONEDA_TARGET          windows-x64 or windows-arm64 (default: detected)
#   YONEDA_DOWNLOAD_BASE   the site to download from (default the one serving this script)

# `iex` runs this in the person's own session: the script block keeps its names out of that
# session, and a failure throws, because `exit` would close their window.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell's progress bar slows downloads many times over.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $site = if ($env:YONEDA_DOWNLOAD_BASE) { $env:YONEDA_DOWNLOAD_BASE } else { '__YONEDA_SITE__' }
  $dir = if ($env:YONEDA_INSTALL_DIR) {
    $env:YONEDA_INSTALL_DIR
  } else {
    Join-Path $env:LOCALAPPDATA 'Programs\yoneda'
  }
  # The x86-64 build, also on arm64 (there is no arm64 one): Windows emulates it there.
  # Its SHA-256 is checked against the file itself (docs/runbook.md: moving the pin).
  $cloudflaredVersion = '2026.10.7'
  $cloudflaredBase = 'https://github.com/cloudflare/cloudflared/releases/download'
  $cloudflaredAsset = 'cloudflared-windows-amd64.exe'
  $cloudflaredSum = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343'

  function Get-Download([string] $Url, [string] $Path) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path
  }

  function Get-Sha256([string] $Path) {
    (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  }

  # Beside its final name, then moved over it. A running program cannot be replaced on
  # Windows but can be renamed, so an old copy is moved aside first.
  function Install-Program([string] $From, [string] $Name) {
    $final = Join-Path $dir $Name
    $next = Join-Path $dir ".$Name.new"
    $old = Join-Path $dir ".$Name.old"
    Copy-Item -LiteralPath $From -Destination $next -Force
    if (Test-Path -LiteralPath $final) { Move-Item -LiteralPath $final -Destination $old -Force }
    Move-Item -LiteralPath $next -Destination $final -Force
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
  }

  function Test-Working([string] $Program) {
    try {
      & $Program --version *> $null
      return $LASTEXITCODE -eq 0
    } catch {
      return $false
    }
  }

  # Every failure warns and returns: yoneda itself is installed by now, and a download that
  # fails its checksum is deleted, never run.
  function Install-Cloudflared([string] $Tmp) {
    $found = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $beside = Join-Path $dir 'cloudflared.exe'
    if ($found -and (Test-Working $found.Source)) {
      Write-Host "cloudflared is already installed: $($found.Source)"
      return
    }
    if ((Test-Path -LiteralPath $beside) -and (Test-Working $beside)) {
      Write-Host "cloudflared is already installed: $beside"
      return
    }
    $download = Join-Path $Tmp $cloudflaredAsset
    try {
      Get-Download "$cloudflaredBase/$cloudflaredVersion/$cloudflaredAsset" $download
    } catch {
      Write-Warning 'could not download cloudflared; Git over SSH needs it, HTTPS Git works without it'
      return
    }
    $actual = Get-Sha256 $download
    if ($actual -ne $cloudflaredSum) {
      Remove-Item -LiteralPath $download -Force
      Write-Warning "cloudflared checksum mismatch: expected $cloudflaredSum, got $actual; not installing it"
      return
    }
    Install-Program $download 'cloudflared.exe'
    Write-Host "Installed cloudflared $cloudflaredVersion in $dir"
  }

  # The user PATH, read raw so %VARIABLES% in it stay unexpanded. Setting any user variable
  # through .NET tells running programs that the environment changed.
  function Add-UserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
      $raw = [string] $key.GetValue(
        'Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $listed = $raw -split ';' | ForEach-Object { $_.TrimEnd('\') }
      if ($listed -notcontains $dir.TrimEnd('\')) {
        $value = ($raw.TrimEnd(';') + ';' + $dir).TrimStart(';')
        $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        [Environment]::SetEnvironmentVariable('YONEDA_PATH_CHANGED', $null, 'User')
        Write-Host "Added $dir to your user PATH"
      }
    } finally {
      $key.Close()
    }
    if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
  }

  $target = $env:YONEDA_TARGET
  if (-not $target) {
    # A 32-bit PowerShell on 64-bit Windows reports the real machine in the second name.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) {
      $env:PROCESSOR_ARCHITEW6432
    } else {
      $env:PROCESSOR_ARCHITECTURE
    }
    $target = switch ($arch) {
      'AMD64' { 'windows-x64' }
      'ARM64' { 'windows-arm64' }
      default { "windows-$arch" }
    }
  }
  if ($target -notin @('windows-x64', 'windows-arm64')) {
    throw "yoneda install: no prebuilt yoneda for $target; build it from source with cargo"
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) "yoneda-install-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $version = $env:YONEDA_VERSION
    if (-not $version) {
      try {
        Get-Download "$site/downloads/cli/LATEST" (Join-Path $tmp 'LATEST')
      } catch {
        throw "yoneda install: could not read the latest version from $site"
      }
      $version = (Get-Content -Raw -LiteralPath (Join-Path $tmp 'LATEST')).Trim()
    }
    if ($version -notmatch '^[0-9A-Za-z.+-]+$') {
      throw "yoneda install: unexpected version '$version'"
    }

    $archive = "yoneda-$version-$target.zip"
    $release = "$site/downloads/cli/$version"
    $archivePath = Join-Path $tmp $archive
    $sumsPath = Join-Path $tmp 'SHA256SUMS'
    foreach ($file in @(@($archive, $archivePath), @('SHA256SUMS', $sumsPath))) {
      try {
        Get-Download "$release/$($file[0])" $file[1]
      } catch {
        throw "yoneda install: could not download $release/$($file[0])"
      }
    }
    $expected = Get-Content -LiteralPath $sumsPath | ForEach-Object {
      $fields = $_ -split '\s+'
      if ($fields.Count -ge 2 -and $fields[1].TrimStart('*') -eq $archive) { $fields[0] }
    } | Select-Object -First 1
    if (-not $expected) { throw "yoneda install: SHA256SUMS does not list $archive" }
    $actual = Get-Sha256 $archivePath
    if ($expected -ne $actual) {
      throw "yoneda install: checksum mismatch for ${archive}: expected $expected, got $actual"
    }

    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $unpacked
    foreach ($program in @('yoneda.exe', 'git-remote-yoneda.exe')) {
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked $program))) {
        throw "yoneda install: $archive has no $program"
      }
    }
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    foreach ($program in @('yoneda.exe', 'git-remote-yoneda.exe')) {
      Install-Program (Join-Path $unpacked $program) $program
    }

    Write-Host "Installed yoneda $version ($target) in $dir"
    Install-Cloudflared $tmp
    # Windows PowerShell has no $IsWindows; PowerShell elsewhere has it false, and no registry.
    if (($null -eq $IsWindows) -or $IsWindows) { Add-UserPath }
    Write-Host 'Next: yoneda login, then yoneda ssh setup for Git over SSH'
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
