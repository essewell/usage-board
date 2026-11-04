# Starts the board (if not already up) and opens a small 800x480 window on the non-primary monitor.
# For fullscreen, add "--kiosk" and set --window-size to $($s.Bounds.Width),$($s.Bounds.Height).
Add-Type -AssemblyName System.Windows.Forms
$port = if ($env:PORT) { $env:PORT } else { 7777 }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  Start-Process node -ArgumentList "`"$here\usage-board.mjs`"" -WorkingDirectory $here -WindowStyle Hidden
  Start-Sleep -Seconds 1
}

# Falls back to the primary screen when the external one is unplugged.
$screens = [System.Windows.Forms.Screen]::AllScreens
$s = ($screens | Where-Object { -not $_.Primary } | Select-Object -First 1)
if (-not $s) { $s = $screens[0] }

$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Error 'Neither Chrome nor Edge found'; exit 1 }

# Separate profile so the window opens as its own process and honours --window-position.
Start-Process $chrome -ArgumentList @(
  "--user-data-dir=$env:TEMP\usage-board-profile",
  "--app=http://localhost:$port",
  "--window-position=$($s.Bounds.X),$($s.Bounds.Y)",
  "--window-size=800,480",
  "--no-first-run"
)
