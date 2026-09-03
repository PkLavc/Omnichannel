[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectRoot)
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')
$privateSettings = Read-OmnichannelEnv -ProjectRoot $project
$localRoot = Join-Path $env:LOCALAPPDATA 'Omnichannel'
$manifestPath = Join-Path $localRoot 'tunnel\omnichannel-endpoint.json'
$logRoot = Join-Path $localRoot 'logs'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$logPath = Join-Path $logRoot 'public-monitor.log'

function Write-MonitorLog([string] $Message) {
  $line = "[$((Get-Date).ToUniversalTime().ToString('o'))] $Message"
  [IO.File]::AppendAllText($logPath, "$line`r`n", [Text.UTF8Encoding]::new($false))
  Write-Host $line
}

function Test-Endpoint([string] $Url, [hashtable] $Headers = @{}) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 15
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return $true }
    } catch {}
    if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
  }
  return $false
}

$mutex = [Threading.Mutex]::new($false, 'Local\OmnichannelPublicMonitor')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { exit 0 }

  $localGateway = Test-Endpoint -Url 'http://localhost:3001/health'
  $localChatwoot = Test-Endpoint -Url 'http://localhost:3000/app/login'
  if (-not $localGateway -or -not $localChatwoot) {
    Write-MonitorLog 'Ambiente local indisponivel; publicacao nao foi alterada.'
    exit 0
  }

  $publicHealthy = $false
  if ([IO.File]::Exists($manifestPath)) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $gatewayUrl = ([string]$manifest.gatewayBaseUrl).TrimEnd('/') + '/health'
      $chatwootUrl = ([string]$manifest.chatwootBaseUrl).TrimEnd('/') + '/app/login'
      $origin = [string]$privateSettings['PUBLIC_ADMIN_ORIGIN']
      $headers = if ($origin) { @{ Origin = $origin } } else { @{} }
      $gatewayHealthy = Test-Endpoint -Url $gatewayUrl -Headers $headers
      $chatwootHealthy = Test-Endpoint -Url $chatwootUrl
      $publicHealthy = [bool]$manifest.online -and $gatewayHealthy -and $chatwootHealthy
    } catch {}
  }

  if ($publicHealthy) {
    Write-MonitorLog 'Acesso publico saudavel.'
    exit 0
  }

  Write-MonitorLog 'Falha publica persistente detectada; recriando os tuneis.'
  & (Join-Path $project 'docker\windows\Start-Public-Access.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel recriar o acesso publico.' }
  Write-MonitorLog 'Tuneis recriados e manifesto republicado.'
} catch {
  Write-MonitorLog "ERRO: $($_.Exception.Message)"
  throw
} finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
