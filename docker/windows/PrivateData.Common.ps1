Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Read-OmnichannelEnvFile {
  param([Parameter(Mandatory = $true)][string] $Path)
  $values = @{}
  if (-not [IO.File]::Exists($Path)) { return $values }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$Matches[1]] = $value
  }
  return $values
}

function Find-OmnichannelDataRoot {
  param([Parameter(Mandatory = $true)][string] $ProjectRoot)

  $project = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
  $legacy = Read-OmnichannelEnvFile -Path (Join-Path $project '.env')
  $locator = Join-Path $env:LOCALAPPDATA 'Omnichannel\data-root.txt'
  $configured = if ($env:OMNICHANNEL_DATA_ROOT) {
    $env:OMNICHANNEL_DATA_ROOT
  } elseif ($legacy['OMNICHANNEL_DATA_ROOT']) {
    $legacy['OMNICHANNEL_DATA_ROOT']
  } elseif ([IO.File]::Exists($locator)) {
    [IO.File]::ReadAllText($locator).Trim()
  } else {
    $null
  }
  if ($configured) {
    if ([IO.Path]::IsPathRooted($configured)) { return [IO.Path]::GetFullPath($configured) }
    return [IO.Path]::GetFullPath((Join-Path $project $configured))
  }

  $parent = [IO.Directory]::GetParent($project).FullName
  $preferred = Join-Path $parent 'omnichannel-data'
  if ([IO.Directory]::Exists($preferred)) { return $preferred }
  $marked = @(
    Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue |
      Where-Object { [IO.File]::Exists((Join-Path $_.FullName '.omnichannel-data-root')) }
  )
  if ($marked.Count -eq 1) { return $marked[0].FullName }
  return $preferred
}

function Get-OmnichannelEnvironmentPaths {
  param([Parameter(Mandatory = $true)][string] $ProjectRoot)
  $dataRoot = Find-OmnichannelDataRoot -ProjectRoot $ProjectRoot
  return @{
    DataRoot = $dataRoot
    Platform = Join-Path $dataRoot 'config\platform.env'
    Machine = Join-Path $dataRoot '_local\machine.env'
  }
}

function Set-OmnichannelComposeEnvironment {
  param([Parameter(Mandatory = $true)][string] $ProjectRoot)
  $paths = Get-OmnichannelEnvironmentPaths -ProjectRoot $ProjectRoot
  $env:OMNICHANNEL_DATA_ROOT = $paths.DataRoot
  $env:OMNICHANNEL_PLATFORM_ENV = $paths.Platform
  $env:COMPOSE_ENV_FILES = $paths.Platform
  return $paths
}

function Read-OmnichannelEnv {
  param([Parameter(Mandatory = $true)][string] $ProjectRoot)

  $paths = Set-OmnichannelComposeEnvironment -ProjectRoot $ProjectRoot
  $values = Read-OmnichannelEnvFile -Path (Join-Path $ProjectRoot '.env')
  foreach ($source in @($paths.Platform, $paths.Machine)) {
    foreach ($entry in (Read-OmnichannelEnvFile -Path $source).GetEnumerator()) {
      $values[$entry.Key] = $entry.Value
    }
  }
  $values['OMNICHANNEL_DATA_ROOT'] = $paths.DataRoot
  return $values
}

function Set-OmnichannelEnvValues {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectRoot,
    [Parameter(Mandatory = $true)][hashtable] $Values,
    [ValidateSet('Platform', 'Machine')][string] $Scope = 'Platform'
  )

  $paths = Get-OmnichannelEnvironmentPaths -ProjectRoot $ProjectRoot
  $path = $paths[$Scope]
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  $lines = [Collections.Generic.List[string]]::new()
  if ([IO.File]::Exists($path)) { $lines.AddRange([string[]][IO.File]::ReadAllLines($path)) }
  foreach ($entry in $Values.GetEnumerator()) {
    $replacement = "$($entry.Key)=$($entry.Value)"
    $index = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*$([regex]::Escape([string]$entry.Key))\s*=") { $index = $i; break }
    }
    if ($index -ge 0) { $lines[$index] = $replacement } else { $lines.Add($replacement) }
  }
  [IO.File]::WriteAllLines($path, $lines, [Text.UTF8Encoding]::new($false))
}

function Resolve-OmnichannelDataRoot {
  param(
    [Parameter(Mandatory = $true)][string] $ProjectRoot,
    [hashtable] $EnvironmentValues = @{}
  )

  $configured = if ($env:OMNICHANNEL_DATA_ROOT) { $env:OMNICHANNEL_DATA_ROOT } elseif ($EnvironmentValues['OMNICHANNEL_DATA_ROOT']) { $EnvironmentValues['OMNICHANNEL_DATA_ROOT'] } else { Find-OmnichannelDataRoot -ProjectRoot $ProjectRoot }
  $project = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
  $root = if ([IO.Path]::IsPathRooted($configured)) {
    [IO.Path]::GetFullPath($configured)
  } else {
    [IO.Path]::GetFullPath((Join-Path $project $configured))
  }
  if ($root.TrimEnd('\').Equals($project, [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith("$project\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "OMNICHANNEL_DATA_ROOT precisa ficar fora do repositorio. Caminho atual: $root"
  }
  if ($root -eq [IO.Path]::GetPathRoot($root)) { throw "OMNICHANNEL_DATA_ROOT nao pode apontar para a raiz de uma unidade." }
  return $root
}

function Initialize-OmnichannelDataFolders {
  param([Parameter(Mandatory = $true)][string] $DataRoot)

  $directories = @('', 'config', '_local', 'imports', 'exports', 'state', 'tenants')
  foreach ($relative in $directories) {
    $path = if ($relative) { Join-Path $DataRoot $relative } else { $DataRoot }
    [IO.Directory]::CreateDirectory($path) | Out-Null
  }
  $marker = Join-Path $DataRoot '.omnichannel-data-root'
  if (-not [IO.File]::Exists($marker)) {
    [IO.File]::WriteAllText($marker, "omnichannel-private-data-v1`n", [Text.UTF8Encoding]::new($false))
  }
}

function Get-RcloneExecutable {
  $installed = Get-Command rclone.exe -ErrorAction SilentlyContinue
  if ($installed) { return $installed.Source }

  $toolsRoot = Join-Path $env:LOCALAPPDATA 'Omnichannel\tools\rclone'
  $executable = Join-Path $toolsRoot 'rclone.exe'
  if ([IO.File]::Exists($executable)) { return $executable }

  [IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ("nexus-rclone-" + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($temporary) | Out-Null
  try {
    $versionResponse = Invoke-WebRequest -UseBasicParsing -Uri 'https://downloads.rclone.org/version.txt'
    $versionText = if ($versionResponse.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($versionResponse.Content).Trim() } else { ([string]$versionResponse.Content).Trim() }
    if ($versionText -notmatch '^rclone (v[0-9]+\.[0-9]+\.[0-9]+)$') { throw 'Versao oficial do rclone invalida.' }
    $version = $Matches[1]
    $archiveName = "rclone-$version-windows-amd64.zip"
    $zip = Join-Path $temporary 'rclone.zip'
    $checksums = Join-Path $temporary 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "https://downloads.rclone.org/$version/$archiveName" -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Uri "https://downloads.rclone.org/$version/SHA256SUMS" -OutFile $checksums
    $expectedLine = [IO.File]::ReadAllLines($checksums) | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
    if (-not $expectedLine) { throw 'Checksum oficial do rclone nao encontrado.' }
    $expected = ($expectedLine -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'O download do rclone falhou na verificacao SHA-256.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $temporary -Force
    $downloaded = Get-ChildItem -LiteralPath $temporary -Filter rclone.exe -Recurse -File | Select-Object -First 1
    if (-not $downloaded) { throw 'rclone.exe nao encontrado no pacote oficial.' }
    Copy-Item -LiteralPath $downloaded.FullName -Destination $executable -Force
  } finally {
    if ([IO.Directory]::Exists($temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  }
  return $executable
}

function Set-RcloneMegaEnvironment {
  param([Parameter(Mandatory = $true)][hashtable] $Values)

  foreach ($required in @('MEGA_USER', 'MEGA_PASS_DPAPI')) {
    if (-not $Values[$required]) { throw "Configuracao local do MEGA ausente: $required" }
  }
  try {
    $protectedPassword = [Convert]::FromBase64String($Values['MEGA_PASS_DPAPI'])
    $entropy = [Text.Encoding]::UTF8.GetBytes('omnichannel-mega-v1')
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $protectedPassword,
      $entropy,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $obscuredPassword = [Text.Encoding]::UTF8.GetString($passwordBytes)
  } catch {
    throw 'A credencial MEGA pertence a outro usuario ou computador. Configure o MEGA uma vez neste Windows.'
  }
  $env:RCLONE_CONFIG_MEGA_TYPE = 'mega'
  $env:RCLONE_CONFIG_MEGA_USER = $Values['MEGA_USER']
  $env:RCLONE_CONFIG_MEGA_PASS = $obscuredPassword
  $env:RCLONE_CONFIG_MEGA_USE_HTTPS = 'true'
  $env:RCLONE_CONFIG_MEGA_HARD_DELETE = 'true'
}
