[CmdletBinding(PositionalBinding=$false)]
param(
  [switch]$InstallNode,
  [switch]$InstallFFmpeg,
  [switch]$ForceReinstall,
  [switch]$OnlyNpm
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Info($msg){ Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn($msg){ Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg){ Write-Host "[ERROR] $msg" -ForegroundColor Red }

function Test-Command($name){ return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Ensure-LocationToRepoRoot {
  $scriptDir = $PSScriptRoot
  $repoRoot = Resolve-Path -LiteralPath (Join-Path $scriptDir '..')
  Set-Location $repoRoot
  Write-Info "Working dir: $repoRoot"
}

function Detect-PackageManager {
  if (Test-Command winget) { return 'winget' }
  if (Test-Command choco) { return 'choco' }
  if (Test-Command scoop) { return 'scoop' }
  return $null
}

function Install-NodeJS([string]$mgr,[switch]$force){
  if (-not $force -and (Test-Command node) -and (Test-Command npm)) {
    Write-Info "Node.js detected: $(node -v) / npm $(npm -v)"
    return
  }
  switch($mgr){
    'winget' {
      Write-Info 'Install/upgrade Node.js (LTS) via winget'
      try { winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements } catch {}
      try { winget upgrade -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements } catch {}
    }
    'choco' { Write-Info 'Install/upgrade Node.js (LTS) via choco'; choco install -y nodejs-lts; choco upgrade -y nodejs-lts }
    'scoop' { Write-Info 'Install/upgrade Node.js (LTS) via scoop'; scoop install nodejs-lts; scoop update nodejs-lts }
    Default { Write-Warn 'No package manager detected. Skip Node.js install. Please install Node.js LTS manually.' }
  }
}

function Install-FFmpeg([string]$mgr,[switch]$force){
  if (-not $force -and (Test-Command ffmpeg) -and (Test-Command ffprobe)) {
    $v = (ffmpeg -version | Select-Object -First 1)
    Write-Info "FFmpeg detected: $v"
    return
  }
  switch($mgr){
    'winget' {
      Write-Info 'Install/upgrade FFmpeg via winget'
      $ids = @('Gyan.FFmpeg','FFmpeg.FFmpeg')
      foreach($id in $ids){
        try { winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements } catch {}
        try { winget upgrade -e --id $id --silent --accept-package-agreements --accept-source-agreements } catch {}
        if (Test-Command ffmpeg) { break }
      }
    }
    'choco' { Write-Info 'Install/upgrade FFmpeg via choco'; choco install -y ffmpeg; choco upgrade -y ffmpeg }
    'scoop' {
      Write-Info 'Install/upgrade FFmpeg via scoop'
      try { scoop bucket add extras } catch {}
      scoop install ffmpeg; scoop update ffmpeg
    }
    Default { Write-Warn 'No package manager detected. Skip FFmpeg install. Please install ffmpeg/ffprobe and add to PATH.' }
  }
}

function Ensure-Dirs {
  $dirs = @('input','clips','open','output','music')
  foreach($d in $dirs){ if(-not (Test-Path $d)){ New-Item -ItemType Directory -Path $d | Out-Null; Write-Info "Created dir: $d" } }
}

function Install-NpmDeps {
  if (-not (Test-Command npm)) { Write-Warn 'npm not found. Skip dependencies.'; return }
  if (Test-Path 'package-lock.json') { Write-Info 'Run: npm ci'; npm ci } else { Write-Info 'Run: npm install'; npm install }
}

function Verify-Env {
  if (Test-Command node) { Write-Info "Node: $(node -v)" } else { Write-Warn 'Node: not found' }
  if (Test-Command npm) { Write-Info "npm: $(npm -v)" } else { Write-Warn 'npm: not found' }
  if (Test-Command ffmpeg) { Write-Info (ffmpeg -version | Select-Object -First 1) } else { Write-Warn 'FFmpeg: not found' }
  if (Test-Command ffprobe) { Write-Info (ffprobe -version | Select-Object -First 1) } else { Write-Warn 'ffprobe: not found' }
  if (Test-Command ffmpeg) {
    $enc = ffmpeg -hide_banner -encoders 2>&1 | Out-String
    if ($enc -match 'h264_nvenc') { Write-Info 'NVIDIA NVENC available' } else { Write-Warn 'NVENC not available/detected' }
    if ($enc -match 'h264_amf')   { Write-Info 'AMD AMF available'    } else { Write-Warn 'AMF not available/detected' }
    if ($enc -match 'libx264')    { Write-Info 'libx264 available'    } else { Write-Warn 'libx264 NOT available (abnormal)' }
  }
}

try {
  Ensure-LocationToRepoRoot
  $mgr = Detect-PackageManager
  if ($OnlyNpm) {
    Ensure-Dirs
    Install-NpmDeps
    Verify-Env
    Write-Host "`nDone (only npm deps installed)." -ForegroundColor Green
    exit 0
  }

  $doNode = $InstallNode -or (-not $InstallFFmpeg -and -not $InstallNode)
  $doFfmpeg = $InstallFFmpeg -or (-not $InstallFFmpeg -and -not $InstallNode)

  if ($doNode)   { Install-NodeJS -mgr $mgr -force:$ForceReinstall }
  if ($doFfmpeg) { Install-FFmpeg -mgr $mgr -force:$ForceReinstall }

  Ensure-Dirs
  Install-NpmDeps
  Verify-Env

  Write-Host "`nSetup completed!" -ForegroundColor Green
  Write-Host 'Usage:' -ForegroundColor Green
  Write-Host '  1) Standardize: node video_standardize.js -d "input/801"' -ForegroundColor Gray
  Write-Host '  2) Split:       node video_split.js' -ForegroundColor Gray
  Write-Host '  3) Concat:      node video_concat.js' -ForegroundColor Gray
  Write-Host '  4) Batch edit:  node video_batch_edit.js' -ForegroundColor Gray
  Write-Host '  5) Audio rand:  node scripts/audio_concat_random.js' -ForegroundColor Gray
  Write-Host "`nNote: you may need to restart PowerShell to refresh PATH." -ForegroundColor Yellow
}
catch {
  Write-Err $_
  exit 1
}
