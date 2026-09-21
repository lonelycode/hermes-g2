# Hermes G2 proxy installer for Windows. Run in PowerShell on the machine that runs Hermes Agent:
#   irm https://raw.githubusercontent.com/lonelycode/hermes-g2/main/proxy/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$pkg = if ($env:HERMES_G2_PACKAGE) { $env:HERMES_G2_PACKAGE } else { 'github:lonelycode/hermes-g2' }

function Need-Node {
  Write-Host 'Node.js 22 or newer is required (20 works without live transcription).'
  Write-Host 'Install it, then re-run this script:'
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  Write-Host '  or download from https://nodejs.org'
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Need-Node }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { Write-Host "Found Node $(node -v); too old."; Need-Node }
if ($major -lt 22) { Write-Host "Note: Node $(node -v) runs the proxy, but live transcription needs Node 22+." }

Write-Host "Installing the Hermes G2 proxy from $pkg …"
npx --yes --package="$pkg" hermes-g2-proxy setup
