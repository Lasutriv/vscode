param(
    [string]$StartIso
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

$start = [DateTime]::Parse($StartIso)
$applicationProviders = @("Application Error", "Windows Error Reporting", "SideBySide")

function Select-WindowsCrashEvent {
    param($Event)

    [PSCustomObject]@{
        channel = $Event.LogName
        eventId = $Event.Id
        level = $Event.LevelDisplayName
        message = $Event.Message
        provider = $Event.ProviderName
        timestamp = $Event.TimeCreated.ToUniversalTime().ToString("o")
    }
}

$events = @()
$events += @(
    Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $start } -ErrorAction SilentlyContinue |
        Where-Object { $applicationProviders -contains $_.ProviderName } |
        ForEach-Object { Select-WindowsCrashEvent $_ }
)

try {
    $events += @(
        Get-WinEvent -FilterHashtable @{ LogName = "Microsoft-Windows-CodeIntegrity/Operational"; StartTime = $start } -ErrorAction Stop |
            ForEach-Object { Select-WindowsCrashEvent $_ }
    )
} catch {
}

$events |
    Sort-Object timestamp -Descending |
    Select-Object -First 100 |
    ConvertTo-Json -Compress -Depth 4
