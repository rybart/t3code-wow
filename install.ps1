# Install or update T3 Code for World of Warcraft on Windows.
#
#   irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1 | iex
#
# Run the same command again to update. From a clone:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Options are the ones install.sh takes: --wow "D:\Games\World of Warcraft" --slots N --no-service
# `irm | iex` can't carry options, so with options the one-liner is:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ryanrhughes/t3code-wow/main/install.ps1))) --wow "D:\Games\World of Warcraft"
#
# Copies the bridge and addon to %USERPROFILE%\.local\share\orca-wow, puts a
# `orca-wow` command on your PATH, then runs `orca-wow install`, which installs the
# addon into the game, gives the bridge a T3 Code session, starts it as a logon task and
# walks you through the first launch. No step needs administrator rights.
#
# It runs on the Windows PowerShell 5.1 that ships with Windows 10 and 11, so it uses
# nothing newer. It never calls `exit`: under `irm | iex` that would close your window.

try {
  & {
    $ErrorActionPreference = 'Stop'
    # Invoke-WebRequest is many times slower in PowerShell 5.1 while it draws its progress bar.
    $ProgressPreference = 'SilentlyContinue'

    $repo = 'ryanrhughes/t3code-wow'
    $ref = if ($env:ORCA_WOW_REF) { $env:ORCA_WOW_REF } else { 'main' }
    $dataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:USERPROFILE '.local\share' }
    $dest = Join-Path $dataHome 'orca-wow'
    # Windows puts this folder on every user's PATH, so nobody's PATH has to be edited.
    $bin = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw 'T3 Code for World of Warcraft needs Node.js 22 or newer: winget install OpenJS.NodeJS.LTS, then open a new PowerShell window.'
    }
    $major = [int](& node -p "process.versions.node.split('.')[0]")
    if ($major -lt 22) {
      throw "T3 Code for World of Warcraft needs Node.js 22 or newer; found $(& node --version)."
    }

    # $PSScriptRoot is empty when this is piped from irm.
    $source = $null
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'bridge')) -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'addon'))) {
      $source = $PSScriptRoot
    }
    $tmp = $null
    try {
      if (-not $source) {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('orca-wow-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp | Out-Null
        Write-Host "Downloading T3 Code for World of Warcraft ($ref)..."
        $url = if ($env:ORCA_WOW_ZIP) { $env:ORCA_WOW_ZIP } else { "https://codeload.github.com/$repo/zip/$ref" }
        $zip = Join-Path $tmp 'source.zip'
        try {
          Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
          Expand-Archive -LiteralPath $zip -DestinationPath $tmp
        } catch {
          throw "Couldn't download $url."
        }
        # The archive holds one folder, named after the repository and the version.
        $source = (Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName
      }

      New-Item -ItemType Directory -Force -Path $dest, $bin | Out-Null
      foreach ($part in 'bridge', 'addon') {
        $new = Join-Path $dest "$part.new"
        if (Test-Path -LiteralPath $new) { Remove-Item -Recurse -Force -LiteralPath $new }
        Copy-Item -Recurse -LiteralPath (Join-Path $source $part) -Destination $new
      }
      foreach ($part in 'bridge', 'addon') {
        $old = Join-Path $dest $part
        if (Test-Path -LiteralPath $old) { Remove-Item -Recurse -Force -LiteralPath $old }
        Rename-Item -LiteralPath (Join-Path $dest "$part.new") -NewName $part
      }
    } finally {
      if ($tmp) { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }
    }

    # The command: a one-line batch file, because a symlink needs Developer Mode or an
    # administrator. `(goto)` ends the batch file before Node starts, so cmd.exe never
    # comes back to read it. That lets `orca-wow uninstall` delete this file while it
    # runs, and makes Node's exit code the command's (both measured). The path starts
    # from %USERPROFILE% where it can, so a profile folder with letters the console's
    # code page lacks still works.
    $cli = Join-Path $dest 'bridge\bin\orca-wow.js'
    $shim = Join-Path $bin 'orca-wow.cmd'
    $target = $cli.Replace('%', '%%')
    if ($cli.StartsWith("$env:USERPROFILE\", [StringComparison]::OrdinalIgnoreCase)) {
      $target = '%USERPROFILE%' + $cli.Substring($env:USERPROFILE.Length).Replace('%', '%%')
    }
    Set-Content -LiteralPath $shim -Encoding Oem -Value ('@(goto) 2>nul & node "{0}" %*' -f $target)
    if (($env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $bin) {
      Write-Host "Note: $bin isn't on your PATH, so run orca-wow as $shim (or add $bin to PATH)."
    }

    # PowerShell 5.1 passes a quoted argument that ends in a backslash wrongly (measured:
    # after --wow "D:\Games\World of Warcraft\" the options that follow became part of
    # the path). A path with a space in it never needs its last backslash.
    $options = @($args | ForEach-Object { if ("$_" -match '\s') { "$_".TrimEnd('\') } else { "$_" } })
    & node $cli install @options
  } @args
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  $global:LASTEXITCODE = 1
}
