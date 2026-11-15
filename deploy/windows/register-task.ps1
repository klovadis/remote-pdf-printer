# Startet den Remote-PDF-Druckserver automatisch bei der Anmeldung (ohne Konsolenfenster).
#
#   powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\register-task.ps1 -Remove
#
# Der Server läuft als der angemeldete Benutzer und kann daher alle Drucker nutzen, die dieser
# Benutzer sieht (auch Netzwerkdrucker). Protokoll: <ConfigDir>\server.log
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\remote-pdf-printer",
    [string]$ConfigDir = "$env:ProgramData\remote-pdf-printer",
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$taskName = 'Remote PDF Printer'

if ($Remove) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Aufgabe '$taskName' entfernt."
    return
}

$pythonw = Join-Path $InstallDir 'venv\Scripts\pythonw.exe'
$config = Join-Path $ConfigDir 'config.toml'
$log = Join-Path $ConfigDir 'server.log'
if (-not (Test-Path $pythonw)) { throw "Nicht gefunden: $pythonw - zuerst install.ps1 ausführen." }
if (-not (Test-Path $config)) { throw "Nicht gefunden: $config - zuerst install.ps1 ausführen." }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $pythonw `
    -Argument "-m remote_pdf_printer -c `"$config`" --log-file `"$log`"" `
    -WorkingDirectory $ConfigDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Nimmt PDFs der Firefox-Erweiterung entgegen und druckt sie.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Aufgabe '$taskName' eingerichtet und gestartet. Protokoll: $log"
