[CmdletBinding()]
param(
  [string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'),
  [switch] $StopServices
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$project = [IO.Path]::GetFullPath($ProjectRoot)
$values = Read-OmnichannelEnv -ProjectRoot $project
$dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $project -EnvironmentValues $values
Initialize-OmnichannelDataFolders -DataRoot $dataRoot

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $dockerCommand) { $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue }
if (-not $dockerCommand) { throw 'Docker CLI nao encontrado.' }
$docker = $dockerCommand.Source
& $docker info | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine nao esta ativo; nao e possivel criar um estado consistente.' }

$composeProject = if ($values['COMPOSE_PROJECT_NAME']) { $values['COMPOSE_PROJECT_NAME'] } else { 'omnichannel-platform' }
$stateRoot = Join-Path $dataRoot 'state'
$stateId = [guid]::NewGuid().ToString('N')
$building = Join-Path $stateRoot ('.building-' + $stateId)
$current = Join-Path $stateRoot 'current'
$previous = Join-Path $stateRoot '.previous'
[IO.Directory]::CreateDirectory($building) | Out-Null

function Invoke-DockerCompose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Arguments)
  & $docker compose --project-directory $project @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose falhou: $($Arguments -join ' ')" }
}

function Export-Volume {
  param([Parameter(Mandatory = $true)][string] $Name)
  $fullName = "${composeProject}_${Name}"
  $exists = @(& $docker volume ls --quiet --filter "name=^${fullName}$") -contains $fullName
  if (-not $exists) { return $false }
  $mount = "$($building -replace '\\','/'):/backup"
  & $docker run --rm -v "${fullName}:/source:ro" -v $mount `
    'pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb' `
    tar -czf "/backup/${Name}.tar.gz" -C /source .
  if ($LASTEXITCODE -ne 0) { throw "Falha ao exportar o volume $fullName." }
  return $true
}

try {
  if ($StopServices) {
    $applicationServices = @('admin', 'gateway', 'n8n', 'chatwoot-worker', 'chatwoot')
    & $docker compose --project-directory $project stop --timeout 60 @applicationServices
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel pausar os servicos antes do backup.' }
  }

  $postgresContainer = "${composeProject}-postgres-1"
  $postgresRunning = (& $docker inspect -f '{{.State.Running}}' $postgresContainer 2>$null) -eq 'true'
  if (-not $postgresRunning) {
    if ([IO.File]::Exists((Join-Path $current 'manifest.json'))) {
      if ($StopServices) { & $docker compose --project-directory $project stop --timeout 60 | Out-Null }
      Remove-Item -LiteralPath $building -Recurse -Force
      Write-Host 'O ambiente ja estava parado; o estado portatil existente foi preservado.'
      exit 0
    }
    throw 'PostgreSQL nao esta ativo e ainda nao existe um estado portatil para sincronizar.'
  }

  $databases = @('gateway', 'chatwoot', 'n8n')
  foreach ($database in $databases) {
    $remoteFile = "/tmp/omnichannel-${database}.dump"
    & $docker exec $postgresContainer pg_dump -U platform -Fc -d $database -f $remoteFile
    if ($LASTEXITCODE -ne 0) { throw "Falha ao exportar o banco $database." }
    & $docker cp "${postgresContainer}:${remoteFile}" (Join-Path $building "postgres-${database}.dump")
    if ($LASTEXITCODE -ne 0) { throw "Falha ao copiar o banco $database." }
    & $docker exec $postgresContainer rm -f $remoteFile | Out-Null
  }

  $redisContainer = "${composeProject}-redis-1"
  $redisRunning = (& $docker inspect -f '{{.State.Running}}' $redisContainer 2>$null) -eq 'true'
  if ($redisRunning) {
    & $docker exec $redisContainer redis-cli SAVE | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao persistir o Redis.' }
  }

  if ($StopServices) {
    Invoke-DockerCompose stop --timeout 60
  }

  $exportedVolumes = [Collections.Generic.List[string]]::new()
  foreach ($volume in @('chatwoot_storage', 'n8n_data', 'redis_data')) {
    if (Export-Volume -Name $volume) { $exportedVolumes.Add($volume) }
  }

  $portableEnvironment = [Collections.Generic.List[string]]::new()
  $environmentPaths = Get-OmnichannelEnvironmentPaths -ProjectRoot $project
  foreach ($line in [IO.File]::ReadAllLines($environmentPaths.Platform)) { $portableEnvironment.Add($line) }
  [IO.File]::WriteAllLines(
    (Join-Path $building 'platform.env'),
    $portableEnvironment,
    [Text.UTF8Encoding]::new($false)
  )

  $files = Get-ChildItem -LiteralPath $building -File | Sort-Object Name
  $checksums = [ordered]@{}
  foreach ($file in $files) {
    $checksums[$file.Name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $metadata = [ordered]@{
    schemaVersion = 1
    stateId = $stateId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    composeProject = $composeProject
    databases = $databases
    volumes = @($exportedVolumes)
    includes = @('clientes', 'cartoes', 'conversas', 'contexto', 'RAG', 'Chatwoot', 'n8n', 'anexos', 'configuracoes')
    checksums = $checksums
  } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $building 'manifest.json'), $metadata, [Text.UTF8Encoding]::new($false))

  if ([IO.Directory]::Exists($previous)) { Remove-Item -LiteralPath $previous -Recurse -Force }
  if ([IO.Directory]::Exists($current)) { Move-Item -LiteralPath $current -Destination $previous }
  Move-Item -LiteralPath $building -Destination $current
  if ([IO.Directory]::Exists($previous)) { Remove-Item -LiteralPath $previous -Recurse -Force }

  $localRoot = Join-Path $dataRoot '_local'
  [IO.Directory]::CreateDirectory($localRoot) | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $localRoot 'applied-state-id'),
    $stateId,
    [Text.UTF8Encoding]::new($false)
  )
  Write-Host "Estado portatil criado: $current"
} catch {
  if ([IO.Directory]::Exists($building)) { Remove-Item -LiteralPath $building -Recurse -Force }
  throw
}
