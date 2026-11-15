# Installiert den Remote-PDF-Druckserver unter Windows.
#
# Aufruf aus dem Ordner des Repositorys (normale PowerShell, keine Administratorrechte nötig):
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1
#
# Voraussetzungen: Python 3.11+ von python.org und SumatraPDF (https://www.sumatrapdfreader.org).
# Ein erneuter Aufruf aktualisiert den Server; eine vorhandene config.toml bleibt unverändert.
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\remote-pdf-printer",
    [string]$ConfigDir = "$env:ProgramData\remote-pdf-printer",
    [string]$StorageDir = "C:\Remote-PDF"
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# --- Python-Umgebung ----------------------------------------------------------------------
$venv = Join-Path $InstallDir 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Host "Erzeuge Python-Umgebung in $venv"
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    if (Get-Command py -ErrorAction SilentlyContinue) {
        & py -3 -m venv $venv
    } elseif (Get-Command python -ErrorAction SilentlyContinue) {
        & python -m venv $venv
    } else {
        throw 'Python nicht gefunden. Bitte von https://www.python.org installieren.'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Python-Umgebung konnte nicht erzeugt werden.' }
}
Write-Host 'Installiere den Server ...'
& $python -m pip install --quiet --upgrade (Join-Path $repo 'server')
if ($LASTEXITCODE -ne 0) { throw 'pip install ist fehlgeschlagen.' }

# --- Konfiguration ------------------------------------------------------------------------
New-Item -ItemType Directory -Force $ConfigDir | Out-Null
$config = Join-Path $ConfigDir 'config.toml'
if (Test-Path $config) {
    Write-Host "Vorhandene Konfiguration bleibt unverändert: $config"
} else {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

    $text = [IO.File]::ReadAllText((Join-Path $repo 'server\config.example.toml'), [Text.Encoding]::UTF8)
    $text = $text.Replace('BITTE-AENDERN-mindestens-16-zeichen', $token)
    $text = $text.Replace('dir = "/srv/remote-pdf"', "dir = '$StorageDir'")
    [IO.File]::WriteAllText($config, $text, (New-Object Text.UTF8Encoding $false))
    Write-Host "Konfiguration angelegt: $config"
    Write-Host ''
    Write-Host "API-Token für die Firefox-Erweiterung: $token" -ForegroundColor Yellow
}

# --- Prüfen -------------------------------------------------------------------------------
Write-Host ''
Write-Host 'Installierte Drucker:'
& $python -m remote_pdf_printer -c $config printers
Write-Host ''
& $python -m remote_pdf_printer -c $config check
Write-Host ''
Write-Host "Nächste Schritte:"
Write-Host "  1. Druckernamen in $config eintragen (printer = ""..."")"
Write-Host "  2. Testen:    & '$python' -m remote_pdf_printer -c '$config'"
Write-Host "  3. Autostart: powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1"
