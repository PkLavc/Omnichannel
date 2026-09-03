param(
    [string]$Destination,
    [switch]$IncludeEnv
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')
if (-not $Destination) {
    $values = Read-OmnichannelEnv -ProjectRoot $projectRoot
    $dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $projectRoot -EnvironmentValues $values
    $Destination = Join-Path $dataRoot 'backups'
}
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $dockerCommand) { $dockerCommand = Get-Command docker -ErrorAction SilentlyContinue }
if (-not $dockerCommand) { throw "Docker CLI não encontrado." }
$docker = $dockerCommand.Source
$values = Read-OmnichannelEnv -ProjectRoot $projectRoot
$project = if ($values['COMPOSE_PROJECT_NAME']) { $values['COMPOSE_PROJECT_NAME'] } else { 'omnichannel-platform' }
$archiveImage = "pgvector/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
$destinationRoot = [IO.Path]::GetFullPath($Destination)
if ($destinationRoot -in @([IO.Path]::GetPathRoot($destinationRoot), "D:\", "C:\")) {
    throw "Escolha uma pasta específica para o backup."
}
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $destinationRoot $stamp
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

$postgresContainer = "$project-postgres-1"
& $docker exec $postgresContainer sh -lc "pg_dumpall -U platform | gzip -9 > /tmp/omnichannel-all.sql.gz"
if ($LASTEXITCODE -ne 0) { throw "Falha ao exportar PostgreSQL." }
& $docker cp "${postgresContainer}:/tmp/omnichannel-all.sql.gz" (Join-Path $backupDir "postgres-all.sql.gz")
if ($LASTEXITCODE -ne 0) { throw "Falha ao copiar o backup PostgreSQL." }
& $docker exec $postgresContainer rm -f /tmp/omnichannel-all.sql.gz | Out-Null

$mount = "$($backupDir -replace '\\','/'):/backup"
foreach ($volume in @("chatwoot_storage", "n8n_data")) {
    $fullVolume = "${project}_${volume}"
    & $docker run --rm `
        -v "${fullVolume}:/source:ro" `
        -v $mount `
        $archiveImage `
        tar -czf "/backup/${volume}.tar.gz" -C /source .
    if ($LASTEXITCODE -ne 0) { throw "Falha ao exportar o volume $fullVolume." }
}

$metadata = [ordered]@{
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    composeProject = $project
    includes = @("gateway", "RAG", "Chatwoot", "n8n", "contas", "configurações")
    restoreRequiresSameEnvSecrets = $true
} | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText((Join-Path $backupDir "metadata.json"), $metadata, [Text.UTF8Encoding]::new($false))
if ($IncludeEnv) {
    $environmentPaths = Get-OmnichannelEnvironmentPaths -ProjectRoot $projectRoot
    Copy-Item -LiteralPath $environmentPaths.Platform -Destination (Join-Path $backupDir "platform.env") -Force
    Write-Warning "O backup inclui platform.env com segredos. Guarde a pasta em local privado e criptografado."
}

Write-Host "Backup concluído em: $backupDir"
