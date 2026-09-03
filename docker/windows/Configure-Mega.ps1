[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')

$project = [IO.Path]::GetFullPath($ProjectRoot)
$current = Read-OmnichannelEnv -ProjectRoot $project
$dataRoot = Resolve-OmnichannelDataRoot -ProjectRoot $project -EnvironmentValues $current
Initialize-OmnichannelDataFolders -DataRoot $dataRoot

Write-Host "Pasta privada encontrada automaticamente: $dataRoot"
Write-Host 'Use uma conta MEGA dedicada. Ela precisa ter sido aberta no navegador ao menos uma vez para gerar as chaves da conta.'
$user = (Read-Host 'E-mail da conta MEGA').Trim()
if ($user -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'E-mail MEGA invalido.' }
$securePassword = Read-Host 'Senha da conta MEGA' -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
if (-not $password) { throw 'A senha MEGA e obrigatoria.' }

$rclone = Get-RcloneExecutable
$obscuredPassword = (& $rclone obscure $password).Trim()
$password = $null
if ($LASTEXITCODE -ne 0 -or -not $obscuredPassword) { throw 'Nao foi possivel proteger a senha para uso pelo rclone.' }
$entropy = [Text.Encoding]::UTF8.GetBytes('omnichannel-mega-v1')
$protectedPassword = [Security.Cryptography.ProtectedData]::Protect(
  [Text.Encoding]::UTF8.GetBytes($obscuredPassword),
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$protectedPasswordBase64 = [Convert]::ToBase64String($protectedPassword)
$obscuredPassword = $null
$remotePath = if ($current['MEGA_REMOTE_PATH']) { $current['MEGA_REMOTE_PATH'].Trim('/') } else { 'omnichannel-private/private-data' }
$newValues = @{
  MEGA_SYNC_ENABLED = 'false'
  MEGA_USER = $user
  MEGA_PASS_DPAPI = $protectedPasswordBase64
  MEGA_REMOTE_PATH = $remotePath
}
Set-OmnichannelEnvValues -ProjectRoot $project -Values $newValues -Scope Machine
$values = Read-OmnichannelEnv -ProjectRoot $project
Set-RcloneMegaEnvironment -Values $values

Write-Host 'Validando o login no MEGA...'
& $rclone lsd 'mega:' --config NUL --checkers 2 --retries 3 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Nao foi possivel entrar no MEGA. Abra a conta no navegador uma vez, confirme o e-mail e tente novamente.'
}

$remote = "mega:$remotePath"
& $rclone mkdir $remote --config NUL
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel criar ou acessar a pasta privada no MEGA.' }
$entries = @(& $rclone lsf $remote --config NUL --max-depth 1 2>$null)
if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel listar a pasta privada no MEGA.' }
$hasMarker = $entries -contains '.omnichannel-data-root'
$remoteHasPayload = $false
$localFiles = @(
  Get-ChildItem -LiteralPath $dataRoot -File -Recurse -ErrorAction Stop |
    Where-Object {
      $_.Name -ne '.omnichannel-data-root' -and
      $_.FullName -notlike (Join-Path $dataRoot 'backups\*') -and
      $_.FullName -notlike (Join-Path $dataRoot '_local\*')
    }
)
if (-not $hasMarker -and $entries.Count -gt 0) {
  throw 'A pasta remota ja possui arquivos, mas nao tem o marcador do Omnichannel. Use uma conta ou pasta vazia para evitar sobrescrita.'
}
if (-not $hasMarker -and $localFiles.Count -eq 0) {
  throw 'A pasta remota e a pasta local estao vazias. Faca a primeira configuracao no computador que possui o acervo original.'
}
if ($hasMarker -and $localFiles.Count -gt 0) {
  $remoteSizeJson = @(& $rclone size $remote --config NUL --json 2>$null)
  $sizeExitCode = $LASTEXITCODE
  if ($sizeExitCode -ne 0) { throw 'Nao foi possivel medir a copia remota antes do download.' }
  $remoteSize = ($remoteSizeJson -join "`n") | ConvertFrom-Json
  $remoteHasPayload = [long]$remoteSize.count -gt 1
}

$newValues['MEGA_SYNC_ENABLED'] = 'true'
Set-OmnichannelEnvValues -ProjectRoot $project -Values $newValues -Scope Machine
$direction = if ($hasMarker -and $remoteHasPayload) { 'Pull' } else { 'Push' }
& (Join-Path $PSScriptRoot 'Sync-PrivateData.ps1') -Direction $direction -ProjectRoot $project -RequireConfigured
if ($LASTEXITCODE -ne 0) { throw "A sincronizacao inicial $direction falhou." }
if ($direction -eq 'Pull') { Write-Host 'Copia existente encontrada; os dados remotos foram baixados.' }
else { Write-Host 'Pasta remota vazia; os dados deste computador formaram a primeira copia.' }
Write-Host 'MEGA configurado. Os proximos inicios e encerramentos serao automaticos.'
