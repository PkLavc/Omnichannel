[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$project = [IO.Path]::GetFullPath($ProjectRoot)
$values = Read-OmnichannelEnv -ProjectRoot $project
$dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $project -EnvironmentValues $values
$current = Join-Path $dataRoot 'state\current'
$manifestPath = Join-Path $current 'manifest.json'
if (-not [IO.File]::Exists($manifestPath)) {
  Write-Host 'Nenhum estado portatil encontrado; mantendo os volumes locais.'
  exit 0
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1 -or -not $manifest.stateId) { throw 'Manifesto do estado portatil invalido.' }
foreach ($property in $manifest.checksums.PSObject.Properties) {
  $file = Join-Path $current $property.Name
  if (-not [IO.File]::Exists($file)) { throw "Arquivo ausente no estado portatil: $($property.Name)" }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne [string]$property.Value) { throw "Checksum invalido no estado portatil: $($property.Name)" }
}

$localRoot = Join-Path $dataRoot '_local'
$appliedPath = Join-Path $localRoot 'applied-state-id'
$applied = if ([IO.File]::Exists($appliedPath)) { [IO.File]::ReadAllText($appliedPath).Trim() } else { '' }
if ($applied -eq [string]$manifest.stateId) {
  $dockerForCheck = Get-Command docker.exe -ErrorAction SilentlyContinue
  if (-not $dockerForCheck) { $dockerForCheck = Get-Command docker -ErrorAction SilentlyContinue }
  $checkProject = if ($values['COMPOSE_PROJECT_NAME']) { $values['COMPOSE_PROJECT_NAME'] } else { 'omnichannel-platform' }
  $requiredVolumes = @("${checkProject}_postgres_data") + @($manifest.volumes | ForEach-Object { "${checkProject}_$_" })
  $volumesPresent = [bool]$dockerForCheck
  if ($volumesPresent) {
    foreach ($volume in $requiredVolumes) {
      & $dockerForCheck.Source volume inspect $volume *> $null
      if ($LASTEXITCODE -ne 0) { $volumesPresent = $false; break }
    }
  }
  if ($volumesPresent) {
    Write-Host 'Os volumes locais ja correspondem ao estado privado mais recente.'
    exit 0
  }
  Write-Host 'O marcador local existe, mas faltam volumes; restaurando a copia privada.'
}

$portableEnv = Join-Path $current 'platform.env'
if ([IO.File]::Exists($portableEnv)) {
  $localValues = Read-OmnichannelEnv -ProjectRoot $project
  $portableValues = @{}
  foreach ($line in [IO.File]::ReadAllLines($portableEnv)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $portableValues[$Matches[1]] = $Matches[2] }
  }
  foreach ($name in @('MEGA_SYNC_ENABLED', 'MEGA_USER', 'MEGA_PASS_DPAPI', 'MEGA_REMOTE_PATH', 'OMNICHANNEL_DATA_ROOT', 'COMPOSE_PROJECT_NAME')) {
    $portableValues.Remove($name)
  }
  Set-OmnichannelEnvValues -ProjectRoot $project -Values $portableValues -Scope Platform
  $values = Read-OmnichannelEnv -ProjectRoot $project
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $dockerCommand) { $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue }
if (-not $dockerCommand) { throw 'Docker CLI nao encontrado.' }
$docker = $dockerCommand.Source
$composeProject = if ($values['COMPOSE_PROJECT_NAME']) { $values['COMPOSE_PROJECT_NAME'] } else { 'omnichannel-platform' }

& $docker compose --project-directory $project down --remove-orphans
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel preparar os containers para restauracao.' }

foreach ($volume in @($manifest.volumes)) {
  $archive = Join-Path $current "${volume}.tar.gz"
  if (-not [IO.File]::Exists($archive)) { throw "Arquivo do volume ausente: ${volume}.tar.gz" }
  $fullVolume = "${composeProject}_${volume}"
  & $docker volume create $fullVolume | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o volume $fullVolume." }
  $mount = "$($current -replace '\\','/'):/backup:ro"
  & $docker run --rm -v "${fullVolume}:/target" -v $mount `
    'pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb' `
    sh -lc "find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf /backup/${volume}.tar.gz -C /target"
  if ($LASTEXITCODE -ne 0) { throw "Falha ao restaurar o volume $fullVolume." }
}

# Start only the stateful services here. `postgres-init` authenticates over TCP
# with the new environment password, while a restored PostgreSQL volume may
# still contain the previous password until the ALTER ROLE below runs.
& $docker compose --project-directory $project up -d postgres redis
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel iniciar PostgreSQL e Redis para restauracao.' }
$deadline = (Get-Date).AddMinutes(5)
do {
  $ready = (& $docker inspect -f '{{.State.Health.Status}}' "${composeProject}-postgres-1" 2>$null) -eq 'healthy'
  if (-not $ready) { Start-Sleep -Seconds 3 }
} while (-not $ready -and (Get-Date) -lt $deadline)
if (-not $ready) { throw 'PostgreSQL nao ficou pronto para restauracao.' }

$postgresContainer = "${composeProject}-postgres-1"
$postgresPassword = [string]$values['POSTGRES_PASSWORD']
if (-not $postgresPassword) { throw 'POSTGRES_PASSWORD ausente depois da restauracao da configuracao.' }
$escapedPostgresPassword = $postgresPassword.Replace("'", "''")
"ALTER ROLE platform WITH PASSWORD '$escapedPostgresPassword';" | & $docker exec -i $postgresContainer psql -U platform -d postgres
if ($LASTEXITCODE -ne 0) { throw 'Falha ao sincronizar a senha do PostgreSQL restaurado.' }
foreach ($database in @($manifest.databases)) {
  $dump = Join-Path $current "postgres-${database}.dump"
  if (-not [IO.File]::Exists($dump)) { throw "Dump ausente: postgres-${database}.dump" }
  & $docker cp $dump "${postgresContainer}:/tmp/${database}.dump"
  if ($LASTEXITCODE -ne 0) { throw "Falha ao copiar o dump de $database." }
  & $docker exec $postgresContainer dropdb -U platform --if-exists --force $database
  if ($LASTEXITCODE -ne 0) { throw "Falha ao limpar o banco $database." }
  & $docker exec $postgresContainer createdb -U platform $database
  if ($LASTEXITCODE -ne 0) { throw "Falha ao recriar o banco $database." }
  & $docker exec $postgresContainer pg_restore -U platform --no-owner --no-privileges -d $database "/tmp/${database}.dump"
  if ($LASTEXITCODE -ne 0) { throw "Falha ao restaurar o banco $database." }
  & $docker exec $postgresContainer rm -f "/tmp/${database}.dump" | Out-Null
}

[IO.Directory]::CreateDirectory($localRoot) | Out-Null
[IO.File]::WriteAllText($appliedPath, [string]$manifest.stateId, [Text.UTF8Encoding]::new($false))
Write-Host "Estado portatil restaurado: $($manifest.createdAt)"
