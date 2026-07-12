$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $PSScriptRoot "env\.env"
$BackupDir = Join-Path $PSScriptRoot "backups"
$Stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$ContainerPath = "/tmp/mbbs_yard_$Stamp.dump"
$HostPath = Join-Path $BackupDir "mbbs_yard_$Stamp.dump"

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
Push-Location $Root
try {
  docker compose --env-file $EnvFile exec -T db pg_dump --format=custom --compress=6 --no-owner --no-privileges -U mbbs_app -d mbbs_yard -f $ContainerPath
  if ($LASTEXITCODE -ne 0) { throw "Docker PostgreSQL backup failed." }
  docker compose --env-file $EnvFile cp "db:$ContainerPath" $HostPath
  if ($LASTEXITCODE -ne 0) { throw "Copying the Docker PostgreSQL backup failed." }
  docker compose --env-file $EnvFile exec -T db rm -f $ContainerPath
  Write-Host "Backup created: $HostPath"
} finally {
  Pop-Location
}
