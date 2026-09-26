# Starts the real desktop Chrome that the API drives over CDP (see
# apps/api/src/common/cdp-endpoint.ts and BROWSER_CDP_URL). Run this before
# starting the API (Docker or local) -- it no-ops if it's already running.
#
# HEADLESS BY DEFAULT: no window ever appears while you use the PC. Confirmed
# live from inside the api container that this still reports a real hardware
# WebGL renderer (ANGLE / NVIDIA D3D11, not SwiftShader), genuine "Google
# Chrome" Client Hints brands, platform Windows and navigator.webdriver=false
# -- the same identity as a visible window, minus the window. The one thing
# headless mode changes is the legacy UA string ("HeadlessChrome/..."), so it
# is pinned to the normal form below. That is the single override that
# creates NO contradiction: brands, platform and version already say "real
# Chrome on Windows"; this just makes the string agree with them.
#
# It is a SEPARATE Chrome instance with its own profile folder -- your personal
# Chrome profile (cookies, logins, bookmarks) is never touched.
#
# Deliberately NOT passed:
#  - --enable-automation. A Chrome started this way
# reports navigator.webdriver=false, which a Playwright-launched one cannot.
#  - --remote-allow-origins=*. It would let a WEB PAGE (open in your normal
#    browser) connect to this debug port and drive this Chrome. Confirmed live:
#    without it Chrome rejects such a connection (HTTP 403) while Playwright's
#    (no Origin header) is still accepted -- the flag disabled a real
#    protection for no benefit.
#
#   .\start-host-chrome.ps1            # headless (default)
#   .\start-host-chrome.ps1 -Visible   # headed, if you ever want to watch it
#   .\start-host-chrome.ps1 -Stop      # kill it (used by the stop-*.bat scripts)

param([switch]$Visible, [switch]$Stop)

$ErrorActionPreference = 'Stop'

if ($Stop) {
  $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '9222' -and $_.Name -match 'chrome' } | Select-Object -First 1
  if ($proc) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Host Chrome stopped."
  } else {
    Write-Host "Host Chrome was not running."
  }
  exit 0
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw "Google Chrome not found." }

$profileDir = "$env:USERPROFILE\.findurjob\host-chrome-profile"
New-Item -ItemType Directory -Force $profileDir | Out-Null

# Already running on the debug port? Check if it matches requested visibility
try {
  $v = Invoke-RestMethod http://127.0.0.1:9222/json/version -TimeoutSec 2
  $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '9222' -and $_.Name -match 'chrome' } | Select-Object -First 1
  $isHeadless = $proc -and ($proc.CommandLine -match '--headless')
  if (($Visible -and -not $isHeadless) -or (-not $Visible -and $isHeadless)) {
    $mode = if ($isHeadless) { 'headless' } else { 'visible' }
    Write-Host "Host Chrome already running on :9222 ($mode): $($v.Browser)"
    exit 0
  }
  Write-Host "Host Chrome on :9222 does not match requested mode (headless=$isHeadless vs requested visible=$Visible). Stopping to restart correctly..."
  if ($proc) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
} catch {}

# Derive the normal UA from the installed version so it never drifts from the
# real engine (Client Hints expose the true version regardless).
$major = ((Get-Item $chrome).VersionInfo.ProductVersion -split '\.')[0]
$ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"

$args = @(
  '--remote-debugging-port=9222',
  "`"--user-data-dir=$profileDir`"",
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1920,1080',
  '--lang=fr-FR'
)
if (-not $Visible) {
  $args += '--headless=new'
  $args += "`"--user-agent=$ua`""
}
$args += 'about:blank'

# One string, with the space-containing arguments quoted above: Start-Process
# does not quote array elements itself, and an unquoted UA gets split into
# several bogus arguments.
Start-Process $chrome -ArgumentList ($args -join ' ')

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $v = Invoke-RestMethod http://127.0.0.1:9222/json/version -TimeoutSec 2
    $mode = if ($Visible) { 'visible' } else { 'headless' }
    Write-Host "Host Chrome ready on :9222 ($mode) -- $($v.Browser)"
    exit 0
  } catch {}
}
throw "Chrome started but the debug port never answered."
