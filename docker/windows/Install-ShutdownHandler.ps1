[CmdletBinding()]
param([string] $ProjectRoot = $(Join-Path $PSScriptRoot '..\..'))

$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectRoot)
$handler = Join-Path $project 'docker\windows\Stop-OmnichannelForShutdown.ps1'
$taskName = 'Omnichannel - Parada segura'
$autoHandler = Join-Path $project 'docker\windows\Auto-Sync-PrivateData.ps1'
$autoTaskName = 'Omnichannel - Sincronizacao automatica'
$publicHandler = Join-Path $project 'docker\windows\Monitor-Public-Access.ps1'
$publicTaskName = 'Omnichannel - Monitor publico'
$hiddenLauncher = Join-Path $project 'docker\windows\Run-HiddenPowerShell.vbs'
if (-not [IO.File]::Exists($hiddenLauncher)) { throw "Lancador invisivel ausente: $hiddenLauncher" }
$wscriptCommand = Join-Path $env:SystemRoot 'System32\wscript.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$arguments = "`"$hiddenLauncher`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$handler`" -ProjectRoot `"$project`""
$escapedArguments = [Security.SecurityElement]::Escape($arguments)
$escapedWscriptCommand = [Security.SecurityElement]::Escape($wscriptCommand)
$escapedSid = [Security.SecurityElement]::Escape($sid)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Para o Omnichannel graciosamente quando o Windows recebe uma solicitacao de desligamento ou reinicio.</Description></RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="System"&gt;&lt;Select Path="System"&gt;*[System[Provider[@Name='User32'] and EventID=1074]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$escapedSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$escapedWscriptCommand</Command><Arguments>$escapedArguments</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Write-Host "Tarefa de desligamento instalada: $taskName"

$autoArguments = "`"$hiddenLauncher`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$autoHandler`" -ProjectRoot `"$project`" -DebounceMinutes 15 -MaxDelayMinutes 120"
$escapedAutoArguments = [Security.SecurityElement]::Escape($autoArguments)
$startBoundary = (Get-Date).AddMinutes(1).ToString('s')
$autoXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Salva e sincroniza alteracoes privadas do Omnichannel com o MEGA sem depender do desligamento manual.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>PT15M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$escapedSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit><Priority>6</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$escapedWscriptCommand</Command><Arguments>$escapedAutoArguments</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $autoTaskName -Xml $autoXml -Force | Out-Null
Write-Host "Tarefa de sincronizacao instalada: $autoTaskName"

$publicArguments = "`"$hiddenLauncher`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$publicHandler`" -ProjectRoot `"$project`""
$escapedPublicArguments = [Security.SecurityElement]::Escape($publicArguments)
$publicStartBoundary = (Get-Date).AddMinutes(5).ToString('s')
$publicXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Valida o acesso externo do Omnichannel e recria tuneis temporarios somente apos falhas persistentes.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$publicStartBoundary</StartBoundary><Enabled>true</Enabled>
      <Repetition><Interval>PT5M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$escapedSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>6</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$escapedWscriptCommand</Command><Arguments>$escapedPublicArguments</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $publicTaskName -Xml $publicXml -Force | Out-Null
Write-Host "Tarefa de monitoramento instalada: $publicTaskName"
