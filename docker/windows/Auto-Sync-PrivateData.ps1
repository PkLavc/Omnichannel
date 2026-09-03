[CmdletBinding()]
param(
  [string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'),
  [int] $DebounceMinutes = 15,
  [int] $MaxDelayMinutes = 120,
  [switch] $Force,
  [switch] $MarkCurrentAsSynced
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$project = [IO.Path]::GetFullPath($ProjectRoot)
$values = Read-OmnichannelEnv -ProjectRoot $project
$dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $project -EnvironmentValues $values
Initialize-OmnichannelDataFolders -DataRoot $dataRoot
$localRoot = Join-Path $dataRoot '_local'
$logRoot = Join-Path $localRoot 'logs'
$statePath = Join-Path $localRoot 'auto-sync-state.json'
[IO.Directory]::CreateDirectory($logRoot) | Out-Null
$logPath = Join-Path $logRoot 'auto-sync.log'

function Write-AutoSyncLog([string] $Message) {
  $line = "[$((Get-Date).ToUniversalTime().ToString('o'))] $Message"
  [IO.File]::AppendAllText($logPath, "$line`r`n", [Text.UTF8Encoding]::new($false))
  Write-Host $line
}

function Read-AutoSyncState {
  if (-not [IO.File]::Exists($statePath)) { return $null }
  try { return Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Save-AutoSyncState([hashtable] $State) {
  $temporary = "$statePath.tmp"
  [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Get-ChangeFingerprint {
  $lines = [Collections.Generic.List[string]]::new()
  $scanTargets = @(
    @{ Path = 'config'; Recurse = $true },
    @{ Path = 'archives'; Recurse = $true },
    @{ Path = 'tenants'; Recurse = $true },
    @{ Path = 'exports'; Recurse = $true },
    @{ Path = 'imports'; Recurse = $false },
    @{ Path = 'imports\hablla'; Recurse = $false },
    @{ Path = 'imports\hablla\checkpoints'; Recurse = $true },
    @{ Path = 'imports\gateway'; Recurse = $true }
  )
  foreach ($target in $scanTargets) {
    $scanRoot = Join-Path $dataRoot $target.Path
    if (-not [IO.Directory]::Exists($scanRoot)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $scanRoot -File -Recurse:$target.Recurse -ErrorAction Stop) {
      $relative = $file.FullName.Substring($dataRoot.Length).TrimStart('\').Replace('\','/')
      if ($relative -like 'archives/*.tmp*') { continue }
      $lines.Add("file|$relative|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
    }
  }

  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
  if (-not $docker) { $docker = Get-Command docker -ErrorAction SilentlyContinue }
  if ($docker) {
    $previousErrorPreference = $ErrorActionPreference
    try {
      # Docker Desktop pode estar fechado ou pausado. Isso nao invalida a
      # verificacao dos arquivos; apenas omite o indicador transacional do banco.
      $ErrorActionPreference = 'Continue'
      & $docker.Source info *> $null
      $dockerInfoExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorPreference
    }
    if ($dockerInfoExitCode -eq 0) {
      $composeProject = if ($values['COMPOSE_PROJECT_NAME']) { $values['COMPOSE_PROJECT_NAME'] } else { 'omnichannel-platform' }
      $postgres = "${composeProject}-postgres-1"
      try {
        $ErrorActionPreference = 'Continue'
        $running = @(& $docker.Source inspect -f '{{.State.Running}}' $postgres 2>$null)
        $dockerInspectExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorPreference
      }
      if ($dockerInspectExitCode -eq 0 -and $running -contains 'true') {
        $sql = "SELECT datname||'|'||tup_inserted||'|'||tup_updated||'|'||tup_deleted FROM pg_stat_database WHERE datname IN ('gateway','chatwoot','n8n') ORDER BY datname;"
        try {
          $ErrorActionPreference = 'Continue'
          $databaseRows = @(& $docker.Source exec $postgres psql -U platform -d postgres -Atc $sql 2>$null)
          $dockerExecExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousErrorPreference
        }
        foreach ($row in $databaseRows) {
          if ($row) { $lines.Add("db|$row") }
        }
        if ($dockerExecExitCode -ne 0) { throw 'Nao foi possivel ler o indicador de alteracoes dos bancos.' }
      }
    }
  }

  $canonical = (@($lines | Sort-Object) -join "`n")
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$mutex = [Threading.Mutex]::new($false, 'Local\OmnichannelDataSync')
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) {
    Write-AutoSyncLog 'Outra copia do backup ja esta ativa; esta verificacao foi ignorada.'
    exit 0
  }
  if ($values['MEGA_SYNC_ENABLED'] -ne 'true') {
    Write-AutoSyncLog 'MEGA desativado; nenhuma sincronizacao automatica foi executada.'
    exit 0
  }

  $now = (Get-Date).ToUniversalTime()
  $fingerprint = Get-ChangeFingerprint
  $state = Read-AutoSyncState
  if ($MarkCurrentAsSynced) {
    Save-AutoSyncState -State @{
      lastSyncedFingerprint = $fingerprint
      lastSuccessAt = $now.ToString('o')
      pendingFingerprint = $null
      stableSince = $null
      dirtySince = $null
    }
    Write-AutoSyncLog 'Estado atual marcado como sincronizado.'
    exit 0
  }

  if ($state -and [string]$state.lastSyncedFingerprint -eq $fingerprint -and -not $Force) {
    Write-AutoSyncLog 'Nenhuma alteracao nova detectada.'
    exit 0
  }

  $dirtySince = if ($state -and $state.dirtySince) { [DateTime]::Parse([string]$state.dirtySince).ToUniversalTime() } else { $now }
  $stableSince = if ($state -and [string]$state.pendingFingerprint -eq $fingerprint -and $state.stableSince) {
    [DateTime]::Parse([string]$state.stableSince).ToUniversalTime()
  } else {
    $now
  }
  $lastSuccessAt = if ($state -and $state.lastSuccessAt) { [string]$state.lastSuccessAt } else { $null }
  $stableMinutes = ($now - $stableSince).TotalMinutes
  $dirtyMinutes = ($now - $dirtySince).TotalMinutes
  $shouldSync = $Force -or $stableMinutes -ge $DebounceMinutes -or $dirtyMinutes -ge $MaxDelayMinutes

  if (-not $shouldSync) {
    Save-AutoSyncState -State @{
      lastSyncedFingerprint = if ($state) { [string]$state.lastSyncedFingerprint } else { $null }
      lastSuccessAt = $lastSuccessAt
      pendingFingerprint = $fingerprint
      stableSince = $stableSince.ToString('o')
      dirtySince = $dirtySince.ToString('o')
    }
    Write-AutoSyncLog ("Alteracao detectada; aguardando estabilidade ({0:N0}/{1} min, limite {2} min)." -f $stableMinutes, $DebounceMinutes, $MaxDelayMinutes)
    exit 0
  }

  Write-AutoSyncLog 'Criando estado portatil e enviando alteracoes ao MEGA.'
  & (Join-Path $PSScriptRoot 'Save-PortableState.ps1') -ProjectRoot $project
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o estado portatil automatico.' }
  & (Join-Path $PSScriptRoot 'Sync-PrivateData.ps1') -Direction Push -ProjectRoot $project -RequireConfigured
  if ($LASTEXITCODE -ne 0) { throw 'Falha na sincronizacao automatica com o MEGA.' }

  $completedAt = (Get-Date).ToUniversalTime()
  Save-AutoSyncState -State @{
    # Registra a fotografia observada antes do dump. Gravacoes ocorridas durante
    # o backup permanecem detectaveis no proximo ciclo.
    lastSyncedFingerprint = $fingerprint
    lastSuccessAt = $completedAt.ToString('o')
    pendingFingerprint = $null
    stableSince = $null
    dirtySince = $null
  }
  Write-AutoSyncLog 'Backup automatico concluido e validado pelo sincronizador.'
} catch {
  Write-AutoSyncLog "ERRO: $($_.Exception.Message)"
  throw
} finally {
  if ($acquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
