[CmdletBinding()]
param(
  [string]$ServerUrl,
  [string]$AgentId,
  [string]$Token,
  [string]$SumatraPath = "C:\Program Files\SumatraPDF\SumatraPDF.exe",
  [int]$PollSeconds = 5,
  [switch]$Run
)

$ErrorActionPreference = "Stop"
$InstallDirectory = Join-Path $env:ProgramData "MBBS\YardPrinterAgent"
$InstalledScript = Join-Path $InstallDirectory "MBBSYardPrinterAgent.ps1"
$ConfigPath = Join-Path $InstallDirectory "agent.json"
$LogPath = Join-Path $InstallDirectory "agent.log"
$TaskName = "MBBS Yard Printer Agent"

function Write-AgentLog {
  param([string]$Message)
  $line = "{0:u} {1}" -f (Get-Date), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  $logs = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
  if ($logs -and $logs.Length -gt 5MB) {
    Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
  }
}

function Invoke-AgentApi {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Headers,
    [object]$Body
  )
  $parameters = @{
    Uri = "$($script:Config.serverUrl.TrimEnd('/'))$Path"
    Method = $Method
    Headers = $Headers
    TimeoutSec = 45
  }
  if ($null -ne $Body) {
    $parameters.ContentType = "application/json"
    $parameters.Body = $Body | ConvertTo-Json -Depth 5 -Compress
  }
  return Invoke-RestMethod @parameters
}

function Send-JobState {
  param([object]$Job, [string]$Action, [string]$ErrorMessage = "")
  $headers = @{
    Authorization = "Bearer $($script:Config.token)"
    "x-printer-agent-id" = $script:Config.agentId
    "x-print-lease-token" = $Job.leaseToken
  }
  Invoke-AgentApi -Method "POST" -Path "/api/scm/print-agent/jobs/$($Job.id)/$Action" -Headers $headers -Body @{ error = $ErrorMessage } | Out-Null
}

function Start-AgentLoop {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Agent configuration was not found at $ConfigPath." }
  $script:Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $script:Config.sumatraPath)) { throw "SumatraPDF was not found at $($script:Config.sumatraPath)." }
  Write-AgentLog "Agent $($script:Config.agentId) started for $($script:Config.serverUrl)."
  while ($true) {
    try {
      $headers = @{
        Authorization = "Bearer $($script:Config.token)"
        "x-printer-agent-id" = $script:Config.agentId
      }
      $lease = Invoke-AgentApi -Method "POST" -Path "/api/scm/print-agent/lease" -Headers $headers -Body @{}
      if ($null -eq $lease.job) {
        Start-Sleep -Seconds ([Math]::Max(2, [int]$lease.pollAfterSeconds))
        continue
      }
      $job = $lease.job
      $safeName = [IO.Path]::GetFileName($job.documentName)
      $tempFile = Join-Path $env:TEMP ("mbbs-print-{0}-{1}" -f $job.id, $safeName)
      $started = $false
      try {
        $downloadHeaders = @{
          Authorization = "Bearer $($script:Config.token)"
          "x-printer-agent-id" = $script:Config.agentId
          "x-print-lease-token" = $job.leaseToken
        }
        Invoke-WebRequest -Uri "$($script:Config.serverUrl.TrimEnd('/'))$($job.downloadUrl)" -Headers $downloadHeaders -OutFile $tempFile -TimeoutSec 90
        if ($job.documentSha256) {
          $actualHash = (Get-FileHash -LiteralPath $tempFile -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($actualHash -ne ([string]$job.documentSha256).ToLowerInvariant()) { throw "Downloaded document hash did not match the queued job." }
        }
        Send-JobState -Job $job -Action "started"
        $started = $true
        Write-AgentLog "Printing job $($job.id) to '$($job.printerName)'."
        $quotedPrinter = '"' + ([string]$job.printerName).Replace('"', '\"') + '"'
        $quotedFile = '"' + $tempFile.Replace('"', '\"') + '"'
        $process = Start-Process -FilePath $script:Config.sumatraPath -ArgumentList @("-print-to", $quotedPrinter, "-silent", $quotedFile) -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "SumatraPDF exited with code $($process.ExitCode)." }
        Send-JobState -Job $job -Action "completed"
        Write-AgentLog "Job $($job.id) completed."
      } catch {
        $message = $_.Exception.Message
        try {
          Send-JobState -Job $job -Action $(if ($started) { "uncertain" } else { "failed" }) -ErrorMessage $message
        } catch {
          Write-AgentLog "Could not report job $($job.id) failure: $($_.Exception.Message)"
        }
        Write-AgentLog "Job $($job.id) error: $message"
      } finally {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
      }
    } catch {
      Write-AgentLog "Polling error: $($_.Exception.Message)"
      Start-Sleep -Seconds ([Math]::Max(5, [int]$script:Config.pollSeconds))
    }
  }
}

if ($Run) {
  Start-AgentLoop
  exit
}

if (-not $ServerUrl -or -not $AgentId -or -not $Token) {
  throw "ServerUrl, AgentId, and Token are required for installation. Copy the setup command from the Yard Printer Setup page."
}
if (-not (Test-Path -LiteralPath $SumatraPath)) {
  throw "Install SumatraPDF first, or pass -SumatraPath with its full executable path."
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Copy-Item -LiteralPath $PSCommandPath -Destination $InstalledScript -Force
@{
  serverUrl = $ServerUrl.TrimEnd("/")
  agentId = $AgentId
  token = $Token
  sumatraPath = $SumatraPath
  pollSeconds = [Math]::Max(2, $PollSeconds)
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

& icacls.exe $InstallDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstalledScript`" -Run"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "MBBS Yard Printer Agent installed and started for $AgentId." -ForegroundColor Green
Write-Host "Log: $LogPath"
