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
$AgentVersion = "3"

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
    $parameters.Body = $Body | ConvertTo-Json -Depth 8 -Compress
  }
  return Invoke-RestMethod @parameters
}

function Send-JobState {
  param(
    [object]$Job,
    [string]$Action,
    [string]$ErrorMessage = "",
    [object]$Diagnostics = $null
  )
  $headers = @{
    Authorization = "Bearer $($script:Config.token)"
    "x-printer-agent-id" = $script:Config.agentId
    "x-printer-agent-version" = $AgentVersion
    "x-print-lease-token" = $Job.leaseToken
  }
  Invoke-AgentApi -Method "POST" -Path "/api/scm/print-agent/jobs/$($Job.id)/$Action" -Headers $headers -Body @{
    error = $ErrorMessage
    diagnostics = $Diagnostics
  } | Out-Null
}

function ConvertTo-InputBin {
  param(
    [object]$Value,
    [string]$PrinterName
  )
  if ($null -eq $Value) { return $null }
  $text = ([string]$Value).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) { return $null }
  if ($text -notmatch '^\d+$') {
    throw "Input bin '$text' for printer '$PrinterName' is not an integer from 1 through 65535."
  }
  [long]$parsed = 0
  if (-not [long]::TryParse($text, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
    throw "Input bin '$text' for printer '$PrinterName' is outside the valid range 1 through 65535."
  }
  return [int]$parsed
}

function Get-PrintTargets {
  param([object]$Job)

  $targets = @()
  $canonicalTargets = @($Job.printerTargets)
  if ($canonicalTargets.Count -gt 0) {
    foreach ($candidate in $canonicalTargets) {
      $printerName = ([string]$candidate.printerName).Trim()
      if ([string]::IsNullOrWhiteSpace($printerName)) {
        throw "The print job contained a printer target without a printerName."
      }
      $inputBin = ConvertTo-InputBin -Value $candidate.inputBin -PrinterName $printerName
      $targets += [pscustomobject]@{
        printerName = $printerName
        inputBin = $inputBin
      }
    }
    return @($targets)
  }

  $legacyPrinterNames = @($Job.printerNames)
  foreach ($candidate in $legacyPrinterNames) {
    $printerName = ([string]$candidate).Trim()
    if (-not [string]::IsNullOrWhiteSpace($printerName)) {
      $targets += [pscustomobject]@{
        printerName = $printerName
        inputBin = $null
      }
    }
  }
  if ($targets.Count -eq 0) {
    $printerName = ([string]$Job.printerName).Trim()
    if (-not [string]::IsNullOrWhiteSpace($printerName)) {
      $targets += [pscustomobject]@{
        printerName = $printerName
        inputBin = $null
      }
    }
  }
  if ($targets.Count -eq 0) {
    throw "The print job did not contain a printer destination."
  }
  return @($targets)
}

function Start-AgentLoop {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Agent configuration was not found at $ConfigPath." }
  $script:Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if (-not (Test-Path -LiteralPath $script:Config.sumatraPath)) { throw "SumatraPDF was not found at $($script:Config.sumatraPath)." }
  $script:SumatraVersion = "unknown"
  try {
    $detectedVersion = (Get-Item -LiteralPath $script:Config.sumatraPath).VersionInfo.ProductVersion
    if (-not [string]::IsNullOrWhiteSpace([string]$detectedVersion)) {
      $script:SumatraVersion = [string]$detectedVersion
    }
  } catch {
    Write-AgentLog "Could not read the SumatraPDF version: $($_.Exception.Message)"
  }
  Write-AgentLog "Agent $($script:Config.agentId) v$AgentVersion started for $($script:Config.serverUrl); SumatraPDF $($script:SumatraVersion)."
  while ($true) {
    try {
      $headers = @{
        Authorization = "Bearer $($script:Config.token)"
        "x-printer-agent-id" = $script:Config.agentId
        "x-printer-agent-version" = $AgentVersion
      }
      $lease = Invoke-AgentApi -Method "POST" -Path "/api/scm/print-agent/lease" -Headers $headers -Body @{}
      if ($null -eq $lease.job) {
        Start-Sleep -Seconds ([Math]::Max(2, [int]$lease.pollAfterSeconds))
        continue
      }
      $job = $lease.job
      $receivedAtValue = [DateTimeOffset]::UtcNow
      $receivedAt = $receivedAtValue.ToString("o")
      $queuedAt = $null
      $queueWaitMs = $null
      if (-not [string]::IsNullOrWhiteSpace([string]$job.queuedAt)) {
        $queuedAt = [string]$job.queuedAt
        try {
          $queuedAtValue = [DateTimeOffset]::Parse(
            $queuedAt,
            [Globalization.CultureInfo]::InvariantCulture
          )
          $queueWaitMs = [long][Math]::Round(($receivedAtValue - $queuedAtValue).TotalMilliseconds)
        } catch {
          Write-AgentLog "Job $($job.id) has an unreadable queuedAt value '$queuedAt'."
        }
      }
      $jobWatch = [Diagnostics.Stopwatch]::StartNew()
      $diagnostics = [ordered]@{
        agentVersion = [int]$AgentVersion
        sumatraVersion = $script:SumatraVersion
        receivedAt = $receivedAt
        queuedAt = $queuedAt
        queueWaitMs = $queueWaitMs
        phase = "received"
        pdfBytes = $null
        downloadMs = $null
        hashMs = $null
        startedReportMs = $null
        processingMs = $null
        totalMs = 0
        targets = @()
      }
      $safeName = [IO.Path]::GetFileName($job.documentName)
      $tempFile = Join-Path $env:TEMP ("mbbs-print-{0}-{1}" -f $job.id, $safeName)
      $started = $false
      $phase = "received"
      $processingWatch = $null
      Write-AgentLog "Received job $($job.id) at $receivedAt; queuedAt=$queuedAt; queueWaitMs=$queueWaitMs."
      try {
        $downloadHeaders = @{
          Authorization = "Bearer $($script:Config.token)"
          "x-printer-agent-id" = $script:Config.agentId
          "x-printer-agent-version" = $AgentVersion
          "x-print-lease-token" = $job.leaseToken
        }
        $phase = "download"
        $diagnostics.phase = $phase
        $downloadWatch = [Diagnostics.Stopwatch]::StartNew()
        try {
          Invoke-WebRequest -Uri "$($script:Config.serverUrl.TrimEnd('/'))$($job.downloadUrl)" -Headers $downloadHeaders -OutFile $tempFile -TimeoutSec 90
        } finally {
          $downloadWatch.Stop()
          $diagnostics.downloadMs = [long]$downloadWatch.ElapsedMilliseconds
          if (Test-Path -LiteralPath $tempFile) {
            $diagnostics.pdfBytes = [long](Get-Item -LiteralPath $tempFile).Length
          }
        }
        Write-AgentLog "Job $($job.id) downloaded $($diagnostics.pdfBytes) bytes in $($diagnostics.downloadMs)ms."
        $phase = "hash"
        $diagnostics.phase = $phase
        $hashWatch = [Diagnostics.Stopwatch]::StartNew()
        try {
          if ($job.documentSha256) {
            $actualHash = (Get-FileHash -LiteralPath $tempFile -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne ([string]$job.documentSha256).ToLowerInvariant()) { throw "Downloaded document hash did not match the queued job." }
          }
        } finally {
          $hashWatch.Stop()
          $diagnostics.hashMs = [long]$hashWatch.ElapsedMilliseconds
        }
        Write-AgentLog "Job $($job.id) hash validation completed in $($diagnostics.hashMs)ms."

        $phase = "targets"
        $diagnostics.phase = $phase
        $printTargets = @(Get-PrintTargets -Job $job)
        $targetDiagnostics = @()
        foreach ($target in $printTargets) {
          $targetDiagnostics += [ordered]@{
            printerName = [string]$target.printerName
            inputBin = $target.inputBin
            processId = $null
            launchMs = $null
            waitMs = $null
            totalMs = $null
            exitCode = $null
          }
        }
        $diagnostics.targets = @($targetDiagnostics)

        $phase = "started"
        $diagnostics.phase = $phase
        $diagnostics.totalMs = [long]$jobWatch.ElapsedMilliseconds
        $startedReportWatch = [Diagnostics.Stopwatch]::StartNew()
        try {
          Send-JobState -Job $job -Action "started" -Diagnostics $diagnostics
        } finally {
          $startedReportWatch.Stop()
          $diagnostics.startedReportMs = [long]$startedReportWatch.ElapsedMilliseconds
        }
        $started = $true
        $quotedFile = '"' + $tempFile.Replace('"', '\"') + '"'
        $processingWatch = [Diagnostics.Stopwatch]::StartNew()
        for ($targetIndex = 0; $targetIndex -lt $printTargets.Count; $targetIndex++) {
          $target = $printTargets[$targetIndex]
          $targetDiagnostic = $targetDiagnostics[$targetIndex]
          $printerName = [string]$target.printerName
          $phase = "printing"
          $diagnostics.phase = $phase
          $binLogValue = if ($null -eq $target.inputBin) { "default" } else { [string]$target.inputBin }
          Write-AgentLog "Printing job $($job.id) to '$printerName' with inputBin=$binLogValue."
          $quotedPrinter = '"' + $printerName.Replace('"', '\"') + '"'
          $sumatraArguments = @("-print-to", $quotedPrinter)
          if ($null -ne $target.inputBin) {
            $quotedPrintSettings = '"bin=' + ([string]$target.inputBin) + '"'
            $sumatraArguments += @("-print-settings", $quotedPrintSettings)
          }
          $sumatraArguments += @("-silent", $quotedFile)

          $targetWatch = [Diagnostics.Stopwatch]::StartNew()
          $launchWatch = [Diagnostics.Stopwatch]::StartNew()
          $waitWatch = $null
          try {
            $process = Start-Process -FilePath $script:Config.sumatraPath -ArgumentList $sumatraArguments -PassThru
            $launchWatch.Stop()
            $targetDiagnostic.launchMs = [long]$launchWatch.ElapsedMilliseconds
            $targetDiagnostic.processId = [int]$process.Id

            $waitWatch = [Diagnostics.Stopwatch]::StartNew()
            $heartbeatWatch = [Diagnostics.Stopwatch]::StartNew()
            while (-not $process.WaitForExit(5000)) {
              if ($heartbeatWatch.ElapsedMilliseconds -ge 60000) {
                $targetDiagnostic.waitMs = [long]$waitWatch.ElapsedMilliseconds
                $targetDiagnostic.totalMs = [long]$targetWatch.ElapsedMilliseconds
                $diagnostics.processingMs = [long]$processingWatch.ElapsedMilliseconds
                $diagnostics.totalMs = [long]$jobWatch.ElapsedMilliseconds
                try {
                  Send-JobState -Job $job -Action "heartbeat" -Diagnostics $diagnostics
                  Write-AgentLog "Job $($job.id) heartbeat sent while SumatraPID=$($process.Id) waitMs=$($targetDiagnostic.waitMs)."
                } catch {
                  Write-AgentLog "Job $($job.id) heartbeat failed while SumatraPID=$($process.Id): $($_.Exception.Message)"
                }
                $heartbeatWatch.Restart()
              }
            }
            $process.WaitForExit()
            $waitWatch.Stop()
            $targetDiagnostic.waitMs = [long]$waitWatch.ElapsedMilliseconds
            $targetDiagnostic.exitCode = [int]$process.ExitCode
          } finally {
            if ($launchWatch.IsRunning) {
              $launchWatch.Stop()
              $targetDiagnostic.launchMs = [long]$launchWatch.ElapsedMilliseconds
            }
            if ($null -ne $waitWatch -and $waitWatch.IsRunning) {
              $waitWatch.Stop()
              $targetDiagnostic.waitMs = [long]$waitWatch.ElapsedMilliseconds
            }
            $targetWatch.Stop()
            $targetDiagnostic.totalMs = [long]$targetWatch.ElapsedMilliseconds
          }
          Write-AgentLog "Job $($job.id) SumatraPID=$($targetDiagnostic.processId) printer='$printerName' inputBin=$binLogValue launchMs=$($targetDiagnostic.launchMs) waitMs=$($targetDiagnostic.waitMs) totalMs=$($targetDiagnostic.totalMs) exitCode=$($targetDiagnostic.exitCode)."
          if ($targetDiagnostic.exitCode -ne 0) {
            throw "SumatraPDF exited with code $($targetDiagnostic.exitCode) while printing to '$printerName' with inputBin=$binLogValue."
          }
        }
        $processingWatch.Stop()
        $diagnostics.processingMs = [long]$processingWatch.ElapsedMilliseconds
        $phase = "completed"
        $diagnostics.phase = $phase
        $diagnostics.totalMs = [long]$jobWatch.ElapsedMilliseconds
        Send-JobState -Job $job -Action "completed" -Diagnostics $diagnostics
        Write-AgentLog "Job $($job.id) completed on $($printTargets.Count) printer(s); processingMs=$($diagnostics.processingMs) totalMs=$($diagnostics.totalMs)."
      } catch {
        $message = $_.Exception.Message
        if ($null -ne $processingWatch -and $processingWatch.IsRunning) {
          $processingWatch.Stop()
        }
        if ($null -ne $processingWatch) {
          $diagnostics.processingMs = [long]$processingWatch.ElapsedMilliseconds
        }
        if ($null -eq $diagnostics.pdfBytes -and (Test-Path -LiteralPath $tempFile)) {
          $diagnostics.pdfBytes = [long](Get-Item -LiteralPath $tempFile).Length
        }
        $diagnostics.phase = $phase
        $diagnostics.totalMs = [long]$jobWatch.ElapsedMilliseconds
        $failureAction = if ($started) { "uncertain" } else { "failed" }
        $diagnostics["errorMessage"] = $message
        $diagnostics["errorType"] = $_.Exception.GetType().FullName
        $diagnostics["failureAction"] = $failureAction
        $phasedMessage = "Phase '$phase': $message"
        try {
          Send-JobState -Job $job -Action $failureAction -ErrorMessage $phasedMessage -Diagnostics $diagnostics
        } catch {
          Write-AgentLog "Could not report job $($job.id) failure: $($_.Exception.Message)"
        }
        Write-AgentLog "Job $($job.id) $failureAction in phase '$phase' after $($diagnostics.totalMs)ms: $message"
      } finally {
        $jobWatch.Stop()
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

$upgradeExisting = $false
$hasServerUrl = -not [string]::IsNullOrWhiteSpace($ServerUrl)
$hasAgentId = -not [string]::IsNullOrWhiteSpace($AgentId)
$hasToken = -not [string]::IsNullOrWhiteSpace($Token)
if (-not $hasServerUrl -and -not $hasAgentId -and -not $hasToken -and (Test-Path -LiteralPath $ConfigPath)) {
  $existingConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $ServerUrl = [string]$existingConfig.serverUrl
  $AgentId = [string]$existingConfig.agentId
  $Token = [string]$existingConfig.token
  if (-not $PSBoundParameters.ContainsKey("SumatraPath") -and -not [string]::IsNullOrWhiteSpace([string]$existingConfig.sumatraPath)) {
    $SumatraPath = [string]$existingConfig.sumatraPath
  }
  if (-not $PSBoundParameters.ContainsKey("PollSeconds") -and $null -ne $existingConfig.pollSeconds) {
    $PollSeconds = [int]$existingConfig.pollSeconds
  }
  $upgradeExisting = $true
}
if ([string]::IsNullOrWhiteSpace($ServerUrl) -or [string]::IsNullOrWhiteSpace($AgentId) -or [string]::IsNullOrWhiteSpace($Token)) {
  throw "ServerUrl, AgentId, and Token are required for a fresh installation. To upgrade without re-entering them, run this script with no parameters on a PC that already has agent.json."
}
if (-not (Test-Path -LiteralPath $SumatraPath)) {
  throw "Install SumatraPDF first, or pass -SumatraPath with its full executable path."
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
$sourceScriptPath = [IO.Path]::GetFullPath($PSCommandPath)
$destinationScriptPath = [IO.Path]::GetFullPath($InstalledScript)
if (-not $sourceScriptPath.Equals($destinationScriptPath, [StringComparison]::OrdinalIgnoreCase)) {
  Copy-Item -LiteralPath $PSCommandPath -Destination $InstalledScript -Force
}
@{
  serverUrl = $ServerUrl.TrimEnd("/")
  agentId = $AgentId
  token = $Token
  sumatraPath = $SumatraPath
  pollSeconds = [Math]::Max(2, $PollSeconds)
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

& icacls.exe $InstallDirectory /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" | Out-Null
$WindowsPowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShellPath)) {
  throw "Windows PowerShell was not found at $WindowsPowerShellPath."
}
$action = New-ScheduledTaskAction -Execute $WindowsPowerShellPath -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$InstalledScript`" -Run" -WorkingDirectory $InstallDirectory
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$triggers = @($startupTrigger, $logonTrigger)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
if ($upgradeExisting) {
  Write-Host "MBBS Yard Printer Agent upgraded to v$AgentVersion and restarted for $AgentId." -ForegroundColor Green
} else {
  Write-Host "MBBS Yard Printer Agent v$AgentVersion installed and started for $AgentId." -ForegroundColor Green
}
Write-Host "Log: $LogPath"
