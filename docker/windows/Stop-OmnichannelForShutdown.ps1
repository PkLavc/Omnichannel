[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Continue'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$logRoot = Join-Path $env:LOCALAPPDATA 'Omnichannel\logs'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$log = Join-Path $logRoot 'shutdown.log'

try {
  Start-Transcript -Path $log -Append -Force | Out-Null
  Write-Host "[$(Get-Date -Format o)] Parada segura iniciada."
  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($docker) {
    & (Join-Path $project 'docker\windows\Save-PortableState.ps1') -ProjectRoot $project -StopServices
  } else {
    Write-Warning 'Docker CLI nao encontrado; o Windows/Docker Desktop fara a parada padrao.'
  }
  & (Join-Path $project 'docker\windows\Sync-PrivateData.ps1') -Direction Push -ProjectRoot $project
  Write-Host "[$(Get-Date -Format o)] Parada segura concluida."
} catch {
  Write-Error $_
} finally {
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
