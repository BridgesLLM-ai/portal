param(
  [string]$Distro = 'Ubuntu',
  [string]$LinuxInstallUrl = 'https://bridgesllm.ai/install.sh',
  [switch]$SkipOllama,
  [switch]$SkipOpenClaw
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "→ $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
  Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-InstalledWslDistros {
  try {
    return @(& wsl.exe -l -q 2>$null | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  } catch {
    return @()
  }
}

function Resolve-TargetDistro([string[]]$Distros, [string]$Preferred) {
  if ($Distros -contains $Preferred) {
    return $Preferred
  }

  if ($Preferred -eq 'Ubuntu') {
    $ubuntuMatch = $Distros | Where-Object { $_ -match '^Ubuntu(?:[- ].*)?$' } | Select-Object -First 1
    if ($ubuntuMatch) {
      return $ubuntuMatch
    }
  }

  return $null
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "wsl.exe was not found on PATH. On Windows 10/11, rerun from an elevated PowerShell with: wsl --install -d $Distro"
}

$installedDistros = Get-InstalledWslDistros
$targetDistro = Resolve-TargetDistro -Distros $installedDistros -Preferred $Distro

if (-not $targetDistro) {
  if (-not (Test-IsAdmin)) {
    throw "WSL distro '$Distro' is not installed yet. Re-run this command from an Administrator PowerShell so it can run: wsl --install -d $Distro"
  }

  Write-Step "Installing WSL distro '$Distro'..."
  & wsl.exe --install -d $Distro
  if ($LASTEXITCODE -ne 0) {
    throw "wsl --install failed with exit code $LASTEXITCODE"
  }

  Write-Warn "WSL/Ubuntu install has been started. If Windows asks for a reboot or Ubuntu first-run setup, finish that first, then rerun this command."
  exit 0
}

$flags = @('--local')
if ($SkipOllama) {
  $flags += '--skip-ollama'
}
if ($SkipOpenClaw) {
  $flags += '--skip-openclaw'
}
$flagString = [string]::Join(' ', $flags)

Write-Step "Launching BridgesLLM Portal installer inside WSL distro '$targetDistro'..."
& wsl.exe -d $targetDistro -u root -- bash -lc "curl -fsSL $LinuxInstallUrl | bash -s -- $flagString"
exit $LASTEXITCODE
