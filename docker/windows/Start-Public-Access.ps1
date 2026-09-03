param(
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$TenantSlug = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'PrivateData.Common.ps1')
$privateSettings = Read-OmnichannelEnv -ProjectRoot $ProjectPath
if (-not $TenantSlug) { $TenantSlug = [string]$privateSettings['PUBLIC_TENANT_SLUG'] }
if (-not $TenantSlug) { throw 'PUBLIC_TENANT_SLUG nao foi configurado na pasta de dados privada.' }
if (-not $env:LOCALAPPDATA) {
    throw "A pasta LOCALAPPDATA nao esta disponivel para armazenar o publicador local."
}

$publisherRoot = Join-Path $env:LOCALAPPDATA "Omnichannel"
$cloudflaredDir = Join-Path $publisherRoot "cloudflared"
$cloudflaredExe = Join-Path $cloudflaredDir "cloudflared.exe"
$stateDir = Join-Path $publisherRoot "tunnel"
$manifestFile = Join-Path $stateDir "omnichannel-endpoint.json"
$gistId = [string]$privateSettings['PUBLIC_STATUS_GIST_ID']
if (-not $gistId) { throw 'PUBLIC_STATUS_GIST_ID nao foi configurado na pasta de dados privada.' }
$gistFilename = if ($privateSettings['PUBLIC_STATUS_GIST_FILENAME']) { [string]$privateSettings['PUBLIC_STATUS_GIST_FILENAME'] } else { 'omnichannel-endpoint.json' }
$gistApiUrl = "https://api.github.com/gists/$gistId"
$publisherMutex = [Threading.Mutex]::new($false, "Local\Omnichannel.PublicAccess")
$hasPublisherLock = $false
try {
    $hasPublisherLock = $publisherMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
    $hasPublisherLock = $true
}
if (-not $hasPublisherLock) {
    throw "Outra publicacao do ambiente ja esta em andamento."
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI nao encontrado no PATH."
}

$ProjectPath = [IO.Path]::GetFullPath($ProjectPath)
New-Item -ItemType Directory -Path $cloudflaredDir, $stateDir -Force | Out-Null

function Test-CloudflaredSignature([string]$Path) {
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path
        return [string]$signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'Cloudflare'
    } catch {
        return $false
    }
}

$cloudflaredReady = $false
if (Test-Path -LiteralPath $cloudflaredExe) {
    try {
        & $cloudflaredExe --version 2>$null | Out-Null
        $cloudflaredReady = $LASTEXITCODE -eq 0 -and (Test-CloudflaredSignature $cloudflaredExe)
    } catch {
        $cloudflaredReady = $false
    }
}

if (-not $cloudflaredReady) {
    Write-Host "Baixando o Cloudflare Tunnel..."
    $downloadFile = "$cloudflaredExe.download.exe"
    Remove-Item -LiteralPath $downloadFile, "$cloudflaredExe.download" -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $downloadFile
    & $downloadFile --version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-CloudflaredSignature $downloadFile)) {
        throw "O arquivo baixado do Cloudflare Tunnel e invalido ou nao possui assinatura valida da Cloudflare."
    }
    Move-Item -LiteralPath $downloadFile -Destination $cloudflaredExe -Force
}

function Stop-PreviousTunnel([string]$Name) {
    $pidFile = Join-Path $stateDir "$Name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { return }

    $storedPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$storedPid)) {
        $previous = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
        $sameExecutable = $false
        if ($previous -and $previous.ProcessName -eq 'cloudflared') {
            try { $sameExecutable = [IO.Path]::GetFullPath($previous.Path) -eq [IO.Path]::GetFullPath($cloudflaredExe) } catch {}
        }
        if ($sameExecutable) {
            Stop-Process -Id $storedPid -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

function Start-PublicTunnel([string]$Name, [int]$Port) {
    $stdoutLog = Join-Path $stateDir "$Name.log"
    $stderrLog = Join-Path $stateDir "$Name-error.log"
    $pidFile = Join-Path $stateDir "$Name.pid"
    Stop-PreviousTunnel $Name
    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

    $process = Start-Process -FilePath $cloudflaredExe `
        -ArgumentList @("tunnel", "--url", "http://localhost:$Port", "--no-autoupdate") `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
        -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($pidFile, [string]$process.Id)

    $deadline = (Get-Date).AddMinutes(2)
    do {
        Start-Sleep -Seconds 2
        $logText = ((Get-Content $stdoutLog -Raw -ErrorAction SilentlyContinue), (Get-Content $stderrLog -Raw -ErrorAction SilentlyContinue)) -join "`n"
        $match = [regex]::Match($logText, "https://[a-z0-9-]+\.trycloudflare\.com")
        if ($match.Success) { return $match.Value.TrimEnd('/') }
    } while ((Get-Date) -lt $deadline -and -not $process.HasExited)

    Stop-PreviousTunnel $Name
    throw "O Cloudflare Tunnel nao forneceu URL para $Name na porta $Port. Consulte $stderrLog."
}

function Wait-Endpoint(
    [string]$Name,
    [string]$Url,
    [int]$TimeoutSeconds = 60,
    [switch]$RequireGatewayHealth,
    [string]$ExpectedCorsOrigin = ""
) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = $null
    do {
        try {
            $headers = @{}
            if ($ExpectedCorsOrigin) { $headers.Origin = $ExpectedCorsOrigin }
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $headers -TimeoutSec 12
            if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 400) {
                $lastError = "HTTP $($response.StatusCode)"
            } elseif ($RequireGatewayHealth) {
                $health = $response.Content | ConvertFrom-Json
                if ($health.status -ne 'ok') {
                    $lastError = "resposta de saude inesperada"
                } elseif ($ExpectedCorsOrigin -and $response.Headers['Access-Control-Allow-Origin'] -ne $ExpectedCorsOrigin) {
                    $lastError = "CORS nao autorizado para $ExpectedCorsOrigin"
                } else {
                    return
                }
            } else {
                return
            }
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    throw "O endpoint $Name nao respondeu em $Url. Ultimo erro: $lastError"
}

function Wait-PublicDns([string]$BaseUrl, [int]$TimeoutSeconds = 60) {
    $hostname = ([uri]$BaseUrl).DnsSafeHost
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        foreach ($resolver in @('1.1.1.1', '8.8.8.8')) {
            try {
                $records = Resolve-DnsName $hostname -Server $resolver -Type A -DnsOnly -ErrorAction Stop
                if ($records | Where-Object { $_.Type -eq 'A' -and $_.IPAddress }) {
                    Clear-DnsClientCache -ErrorAction SilentlyContinue
                    return
                }
            } catch {}
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "O hostname $hostname nao foi publicado no DNS da Cloudflare."
}

function Start-ValidatedPublicTunnel(
    [string]$Name,
    [int]$Port,
    [string]$HealthPath,
    [switch]$RequireGatewayHealth,
    [string]$ExpectedCorsOrigin = ""
) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $baseUrl = Start-PublicTunnel $Name $Port
        try {
            Wait-PublicDns $baseUrl 60
            Wait-Endpoint "$Name publico" "$baseUrl$HealthPath" 60 -RequireGatewayHealth:$RequireGatewayHealth -ExpectedCorsOrigin $ExpectedCorsOrigin
            return $baseUrl
        } catch {
            $lastError = $_
            Stop-PreviousTunnel $Name
            if ($attempt -lt 3) {
                Write-Host "Tentativa $attempt do tunel $Name falhou; solicitando outro endereco a Cloudflare..."
            }
        }
    }
    throw $lastError
}

function Get-GitHubCredentialToken {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $null }

    $credentialLines = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }

    foreach ($line in $credentialLines) {
        $parts = $line -split '=', 2
        if ($parts.Count -eq 2 -and $parts[0] -eq 'password' -and $parts[1]) {
            return $parts[1]
        }
    }
    return $null
}

function Assert-PublishedManifest([string]$Content, [string]$ExpectedTimestamp) {
    if (-not $Content) { throw "O manifesto publicado nao foi encontrado no Gist." }
    $published = $Content | ConvertFrom-Json
    if ($published.updatedAt -ne $ExpectedTimestamp -or -not $published.online) {
        throw "O GitHub nao confirmou a versao atual do endpoint publico."
    }
}

function Confirm-PublishedManifest([string]$ExpectedTimestamp) {
    $response = Invoke-RestMethod -Method Get -Uri $gistApiUrl -Headers @{
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "omnichannel-local-publisher"
    }
    Assert-PublishedManifest $response.files.$gistFilename.content $ExpectedTimestamp
}

function Publish-Manifest([string]$Content, [string]$ExpectedTimestamp) {
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        & gh gist edit $gistId --filename $gistFilename $manifestFile | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Confirm-PublishedManifest $ExpectedTimestamp
            return
        }
    }

    $token = Get-GitHubCredentialToken
    if ($token) {
        $headers = @{
            Authorization = "Bearer $token"
            Accept = "application/vnd.github+json"
            "X-GitHub-Api-Version" = "2022-11-28"
            "User-Agent" = "omnichannel-local-publisher"
        }
        $body = @{
            files = @{
                $gistFilename = @{ content = $Content }
            }
        } | ConvertTo-Json -Depth 5 -Compress
        $bodyBytes = [Text.Encoding]::UTF8.GetBytes($body)
        $publishedResponse = Invoke-RestMethod -Method Patch -Uri $gistApiUrl -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bodyBytes
        Assert-PublishedManifest $publishedResponse.files.$gistFilename.content $ExpectedTimestamp
        return
    }

    throw "Nao foi possivel autenticar no GitHub para atualizar o endpoint publico. Autentique o Git desta maquina ou instale e autentique o GitHub CLI."
}

$chatwootUrl = $null
$gatewayUrl = $null
try {
    Wait-Endpoint "Chatwoot local" "http://localhost:3000/app/login" 240
    Wait-Endpoint "Gateway local" "http://localhost:3001/health" 60 -RequireGatewayHealth

    $chatwootUrl = Start-ValidatedPublicTunnel "chatwoot" 3000 "/app/login"
    $gatewayUrl = Start-ValidatedPublicTunnel "gateway" 3001 "/health" -RequireGatewayHealth -ExpectedCorsOrigin ([string]$privateSettings['PUBLIC_ADMIN_ORIGIN'])

    $escapedTenantSlug = $TenantSlug.Replace("'", "''")
    $tenantQuery = @"
select settings->>'chatwootAccountId' || '|' || coalesce(settings->'chatwootInboxIds'->>0, settings->>'chatwootInboxId')
from "Tenant"
where slug = '$escapedTenantSlug' and active = true
limit 1;
"@
    $tenantOutput = $tenantQuery | & docker compose --project-directory $ProjectPath exec -T postgres psql -U platform -d gateway -At 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel consultar o vinculo do tenant no banco do Gateway." }
    $tenantMapping = [string]($tenantOutput | Where-Object { $_ -match '^\d+\|\d+$' } | Select-Object -Last 1)
    if ($tenantMapping -notmatch '^(\d+)\|(\d+)$') {
        throw "O tenant $TenantSlug nao possui Account e Inbox do Chatwoot configurados."
    }
    $chatwootAccountId = [int]$Matches[1]
    $chatwootInboxId = [int]$Matches[2]

    $inboxQuery = "select c.identifier from inboxes i join channel_api c on c.id=i.channel_id and i.channel_type='Channel::Api' where i.id=$chatwootInboxId and i.account_id=$chatwootAccountId limit 1;"
    $inboxOutput = & docker compose --project-directory $ProjectPath exec -T postgres psql -U platform -d chatwoot -Atqc $inboxQuery 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Nao foi possivel consultar a Inbox publica no banco do Chatwoot." }
    $inboxIdentifier = [string]($inboxOutput | Where-Object { $_ -match "^[A-Za-z0-9_-]{10,}$" } | Select-Object -Last 1)
    $inboxIdentifier = $inboxIdentifier.Trim()
    if (-not $inboxIdentifier) { throw "A Inbox publica do Chatwoot nao foi encontrada." }

    $updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    $manifest = [ordered]@{
        online = $true
        chatwootBaseUrl = $chatwootUrl
        gatewayBaseUrl = $gatewayUrl
        inboxIdentifier = $inboxIdentifier
        updatedAt = $updatedAt
    } | ConvertTo-Json
    [IO.File]::WriteAllText($manifestFile, $manifest, [Text.UTF8Encoding]::new($false))

    Publish-Manifest $manifest $updatedAt
} catch {
    if ($chatwootUrl) { Stop-PreviousTunnel "chatwoot" }
    if ($gatewayUrl) { Stop-PreviousTunnel "gateway" }
    throw
}

Write-Host "Chatwoot publico: $chatwootUrl"
Write-Host "Gateway publico: $gatewayUrl"
Write-Host "Manifesto confirmado no GitHub."
$publisherMutex.ReleaseMutex()
$publisherMutex.Dispose()
