[CmdletBinding()]
param(
  [ValidateSet('Pull', 'Push', 'Check')]
  [string] $Direction = 'Check',
  [string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'),
  [switch] $RequireConfigured
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$project = [IO.Path]::GetFullPath($ProjectRoot)
$values = Read-OmnichannelEnv -ProjectRoot $project
$dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $project -EnvironmentValues $values
Initialize-OmnichannelDataFolders -DataRoot $dataRoot

if ($values['MEGA_SYNC_ENABLED'] -ne 'true') {
  if ($RequireConfigured) { throw 'A sincronizacao MEGA ainda nao foi configurada.' }
  Write-Host "Sincronizacao MEGA desabilitada. Pasta privada: $dataRoot"
  exit 0
}

Set-RcloneMegaEnvironment -Values $values
$rclone = Get-RcloneExecutable
$remotePath = if ($values['MEGA_REMOTE_PATH']) { $values['MEGA_REMOTE_PATH'].Trim('/') } else { 'omnichannel-private/private-data' }
$remote = "mega:$remotePath"
$common = @('--config', 'NUL', '--checkers', '4', '--transfers', '2', '--retries', '5', '--low-level-retries', '10')
$syncExcludes = @(
  '--exclude', '/_local/**',
  '--exclude', '/backups/**',
  '--exclude', '/imports/hablla/raw/**',
  '--exclude', '/archives/*.tmp.tar.gz',
  '--exclude', '/archives/*.tar.gz.tmp',
  '--exclude', '/.sync-inventory.json'
)
$remoteInventoryPath = "$remote/.sync-inventory.json"
$localInventoryPath = Join-Path $dataRoot '_local\sync-inventory.json'

function Get-LocalSyncInventory {
  $items = [Collections.Generic.List[object]]::new()
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($dataRoot)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($child in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      $relative = $child.FullName.Substring($dataRoot.Length).TrimStart('\').Replace('\','/')
      $normalized = $relative.ToLowerInvariant()
      if ($child.PSIsContainer) {
        if ($normalized -eq '_local' -or $normalized -eq 'backups' -or $normalized -eq 'imports/hablla/raw') { continue }
        $pending.Push($child.FullName)
        continue
      }
      if ($normalized -eq '.sync-inventory.json' -or $normalized.StartsWith('imports/') -or $normalized -like 'archives/*.tmp.tar.gz' -or $normalized -like 'archives/*.tar.gz.tmp') { continue }
      $items.Add([ordered]@{
        path = $relative
        bytes = [long]$child.Length
        sha256 = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      })
    }
  }
  return [ordered]@{
    schemaVersion = 1
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    files = @($items | Sort-Object { $_['path'] })
  }
}

function Read-RemoteSyncInventory {
  # O primeiro envio ainda nao possui inventario remoto. O Windows PowerShell
  # transforma o stderr nativo do rclone em erro terminante quando a preferencia
  # global e Stop, portanto essa sondagem precisa ser deliberadamente tolerante.
  $previousErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $json = @(& $rclone cat $remoteInventoryPath @common 2>$null)
    $rcloneExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($rcloneExitCode -ne 0 -or $json.Count -eq 0) { return $null }
  try { return ($json -join "`n") | ConvertFrom-Json } catch { return $null }
}

function Write-LocalSyncInventory($Inventory) {
  [IO.Directory]::CreateDirectory((Split-Path $localInventoryPath -Parent)) | Out-Null
  [IO.File]::WriteAllText($localInventoryPath, ($Inventory | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

if ($Direction -eq 'Check') {
  & $rclone lsf $remote @common --include '.omnichannel-data-root' --files-only | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel acessar a pasta privada no MEGA.' }
  Write-Host "MEGA conectado. Pasta privada: $dataRoot"
  exit 0
}

if ($Direction -eq 'Pull') {
  $marker = & $rclone lsf $remote @common --include '.omnichannel-data-root' --files-only
  if ($LASTEXITCODE -ne 0 -or $marker -notcontains '.omnichannel-data-root') {
    throw 'A raiz remota nao possui o marcador de seguranca; download cancelado para proteger os arquivos locais.'
  }
  $remoteSizeJson = @(& $rclone size $remote @common --json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel validar a copia remota antes do download.' }
  $remoteSize = ($remoteSizeJson -join "`n") | ConvertFrom-Json
  if ([long]$remoteSize.count -le 1) {
    throw 'A copia remota ainda nao possui uma base completa. Download cancelado para proteger os dados locais.'
  }
  Write-Host "Baixando alteracoes privadas do MEGA..."
  & $rclone sync $remote $dataRoot @common @syncExcludes
} else {
  $localSizeJson = @(& $rclone size $dataRoot @common @syncExcludes --json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel medir os dados privados antes do envio.' }
  $remoteSizeJson = @(& $rclone size $remote @common --json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel medir a copia remota antes do envio.' }
  $aboutJson = @(& $rclone about 'mega:' @common --json 2>$null)
  if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel consultar o espaco livre no MEGA.' }
  $localSize = ($localSizeJson -join "`n") | ConvertFrom-Json
  $remoteSize = ($remoteSizeJson -join "`n") | ConvertFrom-Json
  $about = ($aboutJson -join "`n") | ConvertFrom-Json
  $safetyBytes = 250MB
  $replaceableBytes = [long]$about.free + [long]$remoteSize.bytes
  Write-Host ("Dados para sincronizar: {0:N2} GB; espaco utilizavel no MEGA: {1:N2} GB." -f ([long]$localSize.bytes / 1GB), ($replaceableBytes / 1GB))
  if ([long]$localSize.bytes + $safetyBytes -gt $replaceableBytes) {
    Set-OmnichannelEnvValues -ProjectRoot $project -Values @{ MEGA_SYNC_ENABLED = 'false' } -Scope Machine
    throw 'Sincronizacao MEGA desativada: os dados ultrapassariam o espaco disponivel com a margem de seguranca.'
  }
  Write-Host 'Calculando inventario SHA-256 dos dados privados...'
  $localInventory = Get-LocalSyncInventory
  Write-LocalSyncInventory -Inventory $localInventory
  $remoteInventory = Read-RemoteSyncInventory
  $remoteIndex = @{}
  if ($remoteInventory) {
    foreach ($item in @($remoteInventory.files)) { $remoteIndex[[string]$item.path] = $item }
  }
  $forceAll = -not $remoteInventory -and [long]$remoteSize.count -gt 1
  $forceUpload = [Collections.Generic.List[object]]::new()
  foreach ($item in @($localInventory.files)) {
    $previous = $remoteIndex[[string]$item.path]
    if ($forceAll -or ($previous -and [long]$previous.bytes -eq [long]$item.bytes -and [string]$previous.sha256 -ne [string]$item.sha256)) {
      $forceUpload.Add($item)
    }
  }
  Write-Host "Enviando alteracoes privadas ao MEGA..."
  & $rclone sync $dataRoot $remote @common @syncExcludes
  if ($LASTEXITCODE -ne 0) { throw "Sincronizacao $Direction falhou com codigo $LASTEXITCODE." }
  $importsRoot = Join-Path $dataRoot 'imports'
  if ([IO.Directory]::Exists($importsRoot)) {
    # Checkpoints e logs podem mudar durante um importador longo. Sao pequenos e
    # sempre sao reenviados; o acervo raw continua excluido e vive nos pacotes.
    & $rclone copy $importsRoot "$remote/imports" @common --exclude '/hablla/raw/**' --ignore-times
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao atualizar checkpoints e logs operacionais no MEGA.' }
  }
  if ($forceUpload.Count -gt 0) {
    Write-Host ("Atualizando {0:N0} arquivo(s) por diferenca de conteudo..." -f $forceUpload.Count)
    foreach ($item in $forceUpload) {
      $sourcePath = Join-Path $dataRoot ([string]$item.path).Replace('/', '\')
      $destinationPath = "$remote/$([string]$item.path)"
      & $rclone copyto $sourcePath $destinationPath @common --ignore-times
      if ($LASTEXITCODE -ne 0) { throw "Falha ao atualizar arquivo divergente no MEGA: $($item.path)" }
    }
  }
  & $rclone copyto $localInventoryPath $remoteInventoryPath @common --ignore-times
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao publicar o inventario SHA-256 no MEGA.' }
}
if ($LASTEXITCODE -ne 0) { throw "Sincronizacao $Direction falhou com codigo $LASTEXITCODE." }
if ($Direction -eq 'Pull') {
  $remoteInventory = Read-RemoteSyncInventory
  if ($remoteInventory) {
    foreach ($item in @($remoteInventory.files)) {
      $localPath = Join-Path $dataRoot ([string]$item.path).Replace('/', '\')
      if (-not [IO.File]::Exists($localPath) -or (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$item.sha256) {
        throw "Arquivo baixado nao confere com o inventario remoto: $($item.path)"
      }
    }
    Write-Host ("Inventario remoto validado: {0:N0} arquivo(s)." -f @($remoteInventory.files).Count)
  } else {
    Write-Warning 'A copia remota e anterior ao inventario SHA-256; valide e envie novamente a partir deste computador.'
  }
}
Write-Host "Sincronizacao $Direction concluida: $dataRoot"
