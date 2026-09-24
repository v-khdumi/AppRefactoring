$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue

$DotnetCommands = @('dotnet restore', 'dotnet build --no-restore -c Release', 'dotnet test -c Release (all test projects; nonempty; no skips)', 'dotnet list package --vulnerable --include-transitive --format json')
$AuditPrefix = 'MODERNIZE_AUDIT_FINDINGS '
$Dotnet10 = @{ Url = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-win-x64.zip'; Sha512 = '24b670ad3d923bfcf47df6c3b034152398b42f6dbc388e10d783aee1cfb5e5817d399fc0ae2a12cfa822a55e61d34830ccb15c50ef6efee437ab874bb7c79430' }
$DotnetInstall = @{ Url = 'https://raw.githubusercontent.com/dotnet/install-scripts/e5cf1dd2d1540ed05ac84f8eb8c5cdec2807621e/src/dotnet-install.ps1'; Sha256 = '3bb07bc8025211836c1e4f9d3f6a044e55b1fb6eec518a6c78851d04e210442b' }

$endpoint = $env:VERIFICATION_ENDPOINT
$token = $env:VERIFICATION_TOKEN
$smokeSnapshot = $env:MODERNIZE_SMOKE_SNAPSHOT
Remove-Item Env:VERIFICATION_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:VERIFICATION_ENDPOINT -ErrorAction SilentlyContinue
Remove-Item Env:MODERNIZE_SMOKE_SNAPSHOT -ErrorAction SilentlyContinue
foreach ($name in 'VERIFICATION_TOKEN', 'VERIFICATION_ENDPOINT', 'MODERNIZE_SMOKE_SNAPSHOT', 'MODERNIZE_SUPERVISOR') { foreach ($scope in 'Machine', 'User') { [Environment]::SetEnvironmentVariable($name, $null, $scope) } }

function Publish-Report($report, [bool]$final) {
  if ($smokeSnapshot) { if ($final) { Write-Output ('MODERNIZE_WINDOWS_REPORT ' + $serializer.Serialize($report)) }; return }
  $body = $serializer.Serialize(@{ report = $report; final = $final })
  Invoke-RestMethod -Method Post -Uri $endpoint -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $body -TimeoutSec 60 | Out-Null
}

function Get-Snapshot {
  if ($smokeSnapshot) {
    $compressed = [Convert]::FromBase64String($smokeSnapshot)
    $input = New-Object IO.MemoryStream(, $compressed)
    $gzip = New-Object IO.Compression.GZipStream($input, [IO.Compression.CompressionMode]::Decompress)
    $reader = New-Object IO.StreamReader($gzip, [Text.Encoding]::UTF8)
    return $serializer.DeserializeObject($reader.ReadToEnd())
  }
  $response = Invoke-WebRequest -UseBasicParsing -Uri $endpoint -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 120
  return $serializer.DeserializeObject([Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()))
}

function Get-VerifiedDownload($url, $algorithm, $expected, $destination) {
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination -TimeoutSec 900; break }
    catch { if ($attempt -eq 5) { throw }; Start-Sleep -Seconds (10 * $attempt) }
  }
  $actual = (Get-FileHash -LiteralPath $destination -Algorithm $algorithm).Hash.ToLowerInvariant()
  if ($actual -ne $expected.ToLowerInvariant()) { Remove-Item -LiteralPath $destination -Force; throw "Integrity verification failed for $url; the toolchain was not installed." }
}

function Test-SafePath($path) {
  if (-not $path -or $path.Length -gt 500 -or $path.Contains('\') -or $path.Contains(':') -or $path.StartsWith('/') -or $path.Contains([char]0)) { return $false }
  foreach ($part in $path.Split('/')) { if (@('', '.', '..', '.git', 'node_modules') -contains $part) { return $false } }
  return $true
}

function New-VerifierUser($name) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $password = 'Mz!' + [Convert]::ToBase64String($bytes) + '9a'
  $secure = ConvertTo-SecureString $password -AsPlainText -Force
  New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $name -ErrorAction SilentlyContinue
  return @{ name = $name; password = $password }
}

function Grant-BatchLogon($names) {
  $policy = 'C:\modernize\rights.inf'
  & secedit.exe /export /cfg $policy /areas USER_RIGHTS | Out-Null
  $sids = @($names | ForEach-Object { '*' + (New-Object Security.Principal.NTAccount($_)).Translate([Security.Principal.SecurityIdentifier]).Value }) -join ','
  $content = Get-Content $policy
  if ($content -match '^SeBatchLogonRight') { $content = $content -replace '^(SeBatchLogonRight\s*=\s*.*)$', "`$1,$sids" } else { $content = $content -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`nSeBatchLogonRight = $sids" }
  Set-Content $policy $content -Encoding Unicode
  & secedit.exe /configure /db C:\modernize\rights.sdb /cfg $policy /areas USER_RIGHTS | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant batch logon to the isolated verifier accounts.' }
  Remove-Item $policy, C:\modernize\rights.sdb -Force -ErrorAction SilentlyContinue
}

function Expand-Variant($root, $files, $account) {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  foreach ($file in $files) {
    if (-not (Test-SafePath $file['path'])) { throw 'Unsafe snapshot path.' }
    $target = Join-Path $root ($file['path'].Replace('/', '\'))
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String($file['content']))
  }
  & icacls.exe $root /inheritance:r /grant:r "${account}:(OI)(CI)F" 'Administrators:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not restrict $root to its verifier account." }
  & icacls.exe "$root\*" /reset /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not apply inherited verifier permissions under $root." }
}

function Invoke-AsUser($account, $cwd, $command, $arguments, $environment, [int]$timeoutSeconds = 1500, [switch]$FullOutput) {
  $started = Get-Date
  $id = [Guid]::NewGuid().ToString('N')
  $wrapper = Join-Path $cwd ".modernize-$id.cmd"
  $stdout = Join-Path $cwd ".modernize-$id.out"
  $stderr = Join-Path $cwd ".modernize-$id.err"
  $exitFile = Join-Path $cwd ".modernize-$id.exit"
  $lines = @('@echo off', "cd /d `"$cwd`"")
  foreach ($key in $environment.Keys) { $lines += "set `"$key=$($environment[$key])`"" }
  $quoted = @($arguments | ForEach-Object { if ($_ -match '[\s"&|<>^]') { '"' + ($_ -replace '"', '""') + '"' } else { $_ } }) -join ' '
  $lines += "`"$command`" $quoted 1> `"$stdout`" 2> `"$stderr`""
  $lines += ">`"$exitFile.tmp`" echo %ERRORLEVEL%"
  $lines += "move /y `"$exitFile.tmp`" `"$exitFile`" >nul"
  [IO.File]::WriteAllLines($wrapper, $lines, (New-Object Text.ASCIIEncoding))
  $task = "modernize-$id"
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$wrapper`"" -WorkingDirectory $cwd
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds ($timeoutSeconds + 120)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -User $account.name -Password $account.password -RunLevel Limited | Out-Null
  $timedOut = $false
  try {
    Start-ScheduledTask -TaskName $task
    while (-not (Test-Path $exitFile)) {
      if (((Get-Date) - $started).TotalSeconds -gt $timeoutSeconds) { $timedOut = $true; break }
      $state = (Get-ScheduledTask -TaskName $task).State
      if ($state -eq 'Ready' -and ((Get-Date) - $started).TotalSeconds -gt 5 -and -not (Test-Path $exitFile)) { Start-Sleep -Milliseconds 500; if (-not (Test-Path $exitFile)) { break } }
      Start-Sleep -Milliseconds 500
    }
    if ($timedOut) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; & taskkill.exe /F /T /FI "USERNAME eq $($account.name)" | Out-Null }
  } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
  $exitCode = $null
  if (-not $timedOut) { if (Test-Path $exitFile) { $exitCode = [int]([IO.File]::ReadAllText($exitFile).Trim()) } else { $exitCode = -1 } }
  $output = if (Test-Path $stdout) { [IO.File]::ReadAllText($stdout) } else { '' }
  $errors = if (Test-Path $stderr) { [IO.File]::ReadAllText($stderr) } else { '' }
  Remove-Item -LiteralPath $wrapper, $stdout, $stderr, $exitFile -Force -ErrorAction SilentlyContinue
  $log = ($output + $errors)
  if ($exitCode -eq -1) { $log += "`nThe isolated process ended without reporting an exit code." }
  if ($log.Length -gt 32000) { $log = $log.Substring($log.Length - 32000) }
  return @{ exitCode = $exitCode; timedOut = $timedOut; log = $log; output = $(if ($FullOutput) { $output } else { '' }); durationMs = [int]((Get-Date) - $started).TotalMilliseconds; display = "$command $quoted" }
}

function Get-Text($file) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($file['content'])) }
function Test-LegacyProject($content) {
  if (-not ($content -match '<Project\b[^>]*\bSdk\s*=')) { return $true }
  if ($content -match '<TargetFrameworkVersion>\s*v[1-4]') { return $true }
  foreach ($match in [regex]::Matches($content, '<TargetFrameworks?>([^<]+)</TargetFrameworks?>')) { foreach ($framework in $match.Groups[1].Value.Split(';')) { if ($framework.Trim() -match '^net[1-4]\d{1,2}$') { return $true } } }
  return $false
}
function Test-TestProject($content) { return $content -match 'Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*</IsTestProject>|Sdk="MSTest\.Sdk|xunit\.v3|TUnit' }

function Get-Tools {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
  $vstest = & $vswhere -latest -products * -find '**\TestPlatform\vstest.console.exe' | Select-Object -First 1
  $nuget = (Get-Command nuget.exe -ErrorAction SilentlyContinue).Source
  if (-not $msbuild -or -not $vstest) { throw 'MSBuild or VSTest was not found in the pinned .NET Framework SDK image.' }
  return @{ msbuild = $msbuild; vstest = $vstest; nuget = $nuget }
}

function Install-Dotnet10($needed) {
  if (-not $needed.sdk) { return }
  $archive = 'C:\modernize\dotnet-sdk.zip'
  Get-VerifiedDownload $Dotnet10.Url 'SHA512' $Dotnet10.Sha512 $archive
  Expand-Archive -LiteralPath $archive -DestinationPath 'C:\dotnet' -Force
  Remove-Item -LiteralPath $archive -Force
  if ($needed.channels.Count) {
    $script = 'C:\modernize\dotnet-install.ps1'
    Get-VerifiedDownload $DotnetInstall.Url 'SHA256' $DotnetInstall.Sha256 $script
    foreach ($channel in $needed.channels) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Runtime dotnet -Channel $channel -InstallDir 'C:\dotnet' -NoPath | Out-Null
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Runtime aspnetcore -Channel $channel -InstallDir 'C:\dotnet' -NoPath | Out-Null
    }
  }
  & icacls.exe 'C:\dotnet' /grant 'Users:(OI)(CI)RX' /T /C /Q | Out-Null
}

function Get-TrxCounts($directory) {
  $counts = @{ tests = 0; skipped = 0; failed = 0 }
  if (-not (Test-Path $directory)) { return $counts }
  foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -Filter '*.trx' -File) {
    $content = [IO.File]::ReadAllText($file.FullName)
    $match = [regex]::Match($content, '<Counters\b[^>]*>')
    if (-not $match.Success) { continue }
    $value = { param($name) $m = [regex]::Match($match.Value, "\b$name=`"(\d+)`""); if ($m.Success) { [int]$m.Groups[1].Value } else { 0 } }
    $total = & $value 'total'
    $counts.tests += $total
    $counts.skipped += [Math]::Max((& $value 'notExecuted'), $total - (& $value 'executed'))
    $counts.failed += (& $value 'failed') + (& $value 'error') + (& $value 'timeout') + (& $value 'aborted')
  }
  return $counts
}

function Complete-TestStep($step, $counts) {
  $passed = ($step.exitCode -eq 0) -and (-not $step.timedOut) -and $counts.tests -gt 0 -and $counts.failed -eq 0 -and $counts.skipped -eq 0
  $note = "Executed tests: $($counts.tests); failed: $($counts.failed); skipped: $($counts.skipped)."
  if ($counts.tests -eq 0) { $note += ' No tests were executed; verification cannot pass.' }
  if ($counts.skipped) { $note += ' Skipped tests leave required coverage unverified.' }
  $step.log = ($step.log + "`n" + $note)
  if (-not $passed -and $step.exitCode -eq 0) { $step.exitCode = 1 }
  return $step
}

function Get-OsvFindings($packages) {
  $unique = @{}
  foreach ($package in $packages) { $unique["$($package.name.ToLowerInvariant())@$($package.version)"] = $package }
  $items = @($unique.Values)
  $advisories = @{}
  for ($offset = 0; $offset -lt $items.Count; $offset += 500) {
    $chunk = @($items[$offset..([Math]::Min($offset + 499, $items.Count - 1))])
    $queries = New-Object System.Collections.ArrayList
    foreach ($package in $chunk) { [void]$queries.Add(@{ package = @{ ecosystem = 'NuGet'; name = [string]$package['name'] }; version = [string]$package['version'] }) }
    $response = Invoke-RestMethod -Method Post -Uri 'https://api.osv.dev/v1/querybatch' -ContentType 'application/json' -Body ($serializer.Serialize(@{ queries = $queries.ToArray() })) -TimeoutSec 60
    if (@($response.results).Count -ne $chunk.Count) { throw 'OSV returned an incomplete result set.' }
    for ($index = 0; $index -lt $chunk.Count; $index++) {
      $result = $response.results[$index]
      if ($result.next_page_token) { throw 'OSV returned paginated results; the audit is incomplete.' }
      foreach ($vulnerability in @($result.vulns)) { if ($vulnerability.id) { if (-not $advisories.ContainsKey($vulnerability.id)) { $advisories[$vulnerability.id] = @() }; $advisories[$vulnerability.id] += $chunk[$index] } }
    }
  }
  $findings = @()
  foreach ($id in $advisories.Keys) {
    $advisory = Invoke-RestMethod -Uri ('https://api.osv.dev/v1/vulns/' + [Uri]::EscapeDataString($id)) -TimeoutSec 30
    if ($advisory.withdrawn) { continue }
    $severity = if ($advisory.database_specific.severity) { [string]$advisory.database_specific.severity } else { 'unknown' }
    foreach ($package in $advisories[$id]) { $findings += @{ package = [string]$package['name']; version = [string]$package['version']; id = [string]$id; severity = $severity } }
  }
  return $findings
}

function Complete-AuditStep($step, $findings) {
  $normalized = New-Object System.Collections.ArrayList
  $blocking = $false
  foreach ($finding in @($findings)) {
    if (-not $finding) { continue }
    $severity = ([string]$finding['severity']).ToLowerInvariant().Replace('moderate', 'medium')
    if (-not $severity) { $severity = 'unknown' }
    $isBlocking = @('high', 'critical', 'unknown') -contains $severity
    if ($isBlocking) { $blocking = $true }
    if ($normalized.Count -lt 100) { [void]$normalized.Add(@{ package = [string]$finding['package']; version = [string]$finding['version']; id = [string]$finding['id']; severity = $severity; blocking = $isBlocking }) }
  }
  $summary = if ($normalized.Count) { $AuditPrefix + $serializer.Serialize(@{ findings = $normalized.ToArray() }) } else { 'No known vulnerabilities were reported.' }
  $log = $step.log
  if ($log.Length -gt (31000 - $summary.Length)) { $log = $log.Substring($log.Length - (31000 - $summary.Length)) }
  $step.log = $log + "`n" + $summary
  $step.exitCode = $(if ($blocking) { 1 } else { 0 })
  return $step
}

function Get-RestoredPackages($root) {
  $packages = @()
  foreach ($config in Get-ChildItem -LiteralPath $root -Recurse -Filter 'packages.config' -File | Where-Object { $_.FullName -notmatch '\\packages\\' }) {
    foreach ($match in [regex]::Matches([IO.File]::ReadAllText($config.FullName), '<package\s+[^>]*id="([^"]+)"[^>]*version="([^"]+)"')) { $packages += @{ name = $match.Groups[1].Value; version = $match.Groups[2].Value } }
  }
  foreach ($assets in Get-ChildItem -LiteralPath $root -Recurse -Filter 'project.assets.json' -File) {
    $content = $serializer.DeserializeObject([IO.File]::ReadAllText($assets.FullName))
    foreach ($key in $content['libraries'].Keys) { $library = $content['libraries'][$key]; if ($library['type'] -eq 'package') { $parts = $key.Split('/'); $packages += @{ name = $parts[0]; version = $parts[1] } } }
  }
  return $packages
}

function Invoke-Variant($variant, $files, $credential, $tools, $report, $state) {
  $root = "C:\work\$variant"
  $environment = @{ DOTNET_CLI_HOME = $root; NUGET_PACKAGES = "$root\.nuget\packages"; DOTNET_CLI_TELEMETRY_OPTOUT = '1'; DOTNET_NOLOGO = '1'; DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'; MSBUILDDISABLENODEREUSE = '1'; TEMP = "$root\.tmp"; TMP = "$root\.tmp"; MODERNIZE_VERIFICATION_VARIANT = $variant; PATH = "C:\dotnet;$env:PATH" }
  New-Item -ItemType Directory -Path "$root\.tmp" -Force | Out-Null
  $projects = @($files | Where-Object { $_['path'] -match '\.(csproj|fsproj|vbproj)$' -and $_['path'] -notmatch '(^|/)(vendor|node_modules|testdata|\.git)/' })
  $solutions = @($files | Where-Object { $_['path'] -match '\.(sln|slnx)$' } | ForEach-Object { $_['path'] })
  $targets = if ($solutions.Count) { $solutions } else { @($projects | ForEach-Object { $_['path'] }) }
  $legacy = @($projects | Where-Object { Test-LegacyProject (Get-Text $_) }).Count -gt 0
  $testProjects = @($projects | Where-Object { Test-TestProject (Get-Text $_) } | ForEach-Object { $_['path'] })
  $runtimeProjects = @($projects | Where-Object { -not (Test-TestProject (Get-Text $_)) } | ForEach-Object { $_['path'] })
  if (-not $testProjects.Count) { $state.missing += "$variant .NET: no test project found" }
  $sequence = {
    param($label, $invocations)
    $log = ''; $exitCode = 0; $timedOut = $false; $duration = 0; $outputs = @()
    foreach ($invocation in $invocations) {
      $result = Invoke-AsUser $credential $root $invocation[0] $invocation[1] $environment -FullOutput:([bool]$invocation[2])
      $log = ($log + "`n$ " + $result.display + "`n" + $result.log); if ($log.Length -gt 32000) { $log = $log.Substring($log.Length - 32000) }
      $duration += $result.durationMs; $outputs += $result
      if ($result.exitCode -ne 0 -or $result.timedOut) { $exitCode = $result.exitCode; $timedOut = $result.timedOut; break }
    }
    return @{ command = $label; exitCode = $exitCode; timedOut = $timedOut; log = $log; durationMs = $duration; outputs = $outputs }
  }
  $steps = @()
  if ($legacy) {
    $solutionText = (@($files | Where-Object { $_['path'] -match '\.(sln|slnx)$' } | ForEach-Object { (Get-Text $_).Replace('\', '/') }) -join "`n")
    $buildTargets = @($targets) + @($testProjects | Where-Object { -not $solutions.Count -or -not $solutionText.Contains(($_ -replace '^.*?/', '')) -and -not $solutionText.Contains($_) } | Where-Object { $targets -notcontains $_ })
    $steps += @{ index = 0; run = { & $sequence $DotnetCommands[0] @($buildTargets | ForEach-Object { ,@($tools.msbuild, @($_, '/t:Restore', '/p:RestorePackagesConfig=true', "/p:SolutionDir=$root\", '/p:Configuration=Release', '/nologo', '/v:minimal')) }) } }
    $steps += @{ index = 1; run = { & $sequence $DotnetCommands[1] @($buildTargets | ForEach-Object { ,@($tools.msbuild, @($_, '/t:Build', "/p:SolutionDir=$root\", '/p:Configuration=Release', '/nologo', '/v:minimal', '/m')) }) } }
    if ($testProjects.Count) {
      $steps += @{ index = 2; run = {
        $assemblies = @()
        foreach ($project in $testProjects) {
          $content = Get-Text ($files | Where-Object { $_['path'] -eq $project })
          $name = [regex]::Match($content, '<AssemblyName>([^<]+)</AssemblyName>').Groups[1].Value
          if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($project) }
          $directory = Join-Path $root (Split-Path -Parent ($project.Replace('/', '\')))
          $assemblies += @(Get-ChildItem -LiteralPath (Join-Path $directory 'bin\Release') -Recurse -Filter "$name.dll" -File -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.FullName })
        }
        if ($assemblies.Count -ne $testProjects.Count) { return @{ command = $DotnetCommands[2]; exitCode = 1; timedOut = $false; log = 'Built test assemblies were not found for every test project.'; durationMs = 0; outputs = @() } }
        $step = & $sequence $DotnetCommands[2] @(,@($tools.vstest, @($assemblies + @('/logger:trx', "/ResultsDirectory:$root\.modernize-trx"))))
        Complete-TestStep $step (Get-TrxCounts "$root\.modernize-trx")
      } }
    }
    $steps += @{ index = 3; audit = $true; run = {
      $step = @{ command = $DotnetCommands[3]; exitCode = 0; timedOut = $false; log = 'NuGet packages from packages.config and restored project assets queried against OSV.'; durationMs = 0; outputs = @() }
      try { Complete-AuditStep $step (Get-OsvFindings (Get-RestoredPackages $root)) } catch { $step.exitCode = 2; $step.log += "`nDependency audit could not be completed: $($_.Exception.Message)"; $step }
    } }
  } else {
    $dotnet = 'C:\dotnet\dotnet.exe'
    $steps += @{ index = 0; run = { & $sequence $DotnetCommands[0] @($targets | ForEach-Object { ,@($dotnet, @('restore', $_)) }) } }
    $steps += @{ index = 1; run = { & $sequence $DotnetCommands[1] @($targets | ForEach-Object { ,@($dotnet, @('build', $_, '--no-restore', '-c', 'Release', '-nologo')) }) } }
    if ($testProjects.Count) {
      $steps += @{ index = 2; run = {
        $invocations = @(); $index = 0
        foreach ($project in $testProjects) { $invocations += ,@($dotnet, @('test', $project, '-c', 'Release', '--logger', 'trx', '--results-directory', "$root\.modernize-trx\$index")); $index++ }
        Complete-TestStep (& $sequence $DotnetCommands[2] $invocations) (Get-TrxCounts "$root\.modernize-trx")
      } }
    }
    $auditTargets = if ($runtimeProjects.Count) { $runtimeProjects } else { $targets }
    $steps += @{ index = 3; audit = $true; run = {
      $step = & $sequence $DotnetCommands[3] @($auditTargets | ForEach-Object { ,@($dotnet, @('list', $_, 'package', '--vulnerable', '--include-transitive', '--format', 'json'), $true) })
      if ($step.exitCode -ne 0 -or $step.timedOut) { return $step }
      try {
        $findings = @()
        foreach ($output in $step.outputs) {
          $text = $output.output; $parsed = $serializer.DeserializeObject($text.Substring($text.IndexOf('{')))
          foreach ($project in @($parsed['projects'])) { if (-not $project -or -not $project['frameworks']) { continue }; foreach ($framework in @($project['frameworks'])) { if (-not $framework) { continue }; $packages = @(); if ($framework['topLevelPackages']) { $packages += @($framework['topLevelPackages']) }; if ($framework['transitivePackages']) { $packages += @($framework['transitivePackages']) }; foreach ($item in $packages) { if (-not $item -or -not $item['vulnerabilities']) { continue }; foreach ($vulnerability in @($item['vulnerabilities'])) { if ($vulnerability) { $findings += @{ package = [string]$item['id']; version = [string]$item['resolvedVersion']; id = ([string]$vulnerability['advisoryurl']).Split('/')[-1]; severity = [string]$vulnerability['severity'] } } } } } }
        }
        Complete-AuditStep $step $findings
      } catch { $step.exitCode = 2; $step.log += "`nThe tool output could not be evaluated: $($_.Exception.Message)"; $step }
    } }
  }
  foreach ($item in $steps) {
    $step = & $item.run
    $step.Remove('outputs')
    $step['variant'] = $variant; $step['project'] = '.'
    $report.steps += $step
    Publish-Report @{ status = 'failed'; reason = "${variant}: .: $($step.command)"; steps = $report.steps } $false
    if ($step.exitCode -ne 0 -or $step.timedOut) {
      if ($variant -eq 'baseline' -and $item.audit -and $step.exitCode -eq 1 -and $step.log.Contains($AuditPrefix)) { $state.baselineAudit += "baseline .: pre-existing dotnet dependency vulnerabilities (see audit report)."; continue }
      $state.failures += "$variant dotnet .: $($step.command) $(if ($step.timedOut) { 'timed out' } else { "failed (exit $($step.exitCode))" })."
      if ($item.index -lt 2 -or $step.timedOut) { break }
    }
  }
}

$report = @{ status = 'failed'; reason = 'Verification started'; steps = @() }
try {
  $snapshot = Get-Snapshot
  New-Item -ItemType Directory -Path 'C:\modernize' -Force | Out-Null
  $all = @($snapshot['baseline']) + @($snapshot['candidate'])
  $needed = @{ sdk = $false; channels = @() }
  foreach ($file in $all | Where-Object { $_['path'] -match '\.(csproj|fsproj|vbproj)$' }) {
    $content = Get-Text $file
    if (-not (Test-LegacyProject $content)) { $needed.sdk = $true }
    foreach ($match in [regex]::Matches($content, '<TargetFrameworks?>([^<]+)</TargetFrameworks?>')) { foreach ($framework in $match.Groups[1].Value.Split(';')) { $version = [regex]::Match($framework.Trim(), '^(?:netcoreapp(\d+\.\d+)|net([5-9]|\d{2,})\.(\d+))$'); if ($version.Success) { $channel = if ($version.Groups[1].Success) { $version.Groups[1].Value } else { "$($version.Groups[2].Value).$($version.Groups[3].Value)" }; if ($channel -ne '10.0' -and $needed.channels -notcontains $channel) { $needed.channels += $channel } } } }
  }
  Publish-Report @{ status = 'failed'; reason = 'Preparing the pinned Windows .NET Framework verifier, isolated accounts and checksum-verified .NET SDK.'; steps = @() } $false
  Install-Dotnet10 $needed
  $tools = Get-Tools
  $baselineUser = New-VerifierUser 'mzbaseline'
  $candidateUser = New-VerifierUser 'mzcandidate'
  Grant-BatchLogon @('mzbaseline', 'mzcandidate')
  New-Item -ItemType Directory -Path 'C:\work\isolation-check' -Force | Out-Null
  & icacls.exe 'C:\work\isolation-check' /grant 'mzcandidate:(OI)(CI)F' /T /C /Q | Out-Null
  $probe = Invoke-AsUser $candidateUser 'C:\work\isolation-check' 'cmd.exe' @('/d', '/c', 'whoami & set') @{} 120
  if ($probe.exitCode -ne 0 -or $probe.log -notmatch 'mzcandidate') { throw "Repository commands could not run as the isolated verifier account: $($probe.log)" }
  if (($token -and $probe.log.Contains($token)) -or ($smokeSnapshot -and $probe.log.Contains($smokeSnapshot.Substring(0, [Math]::Min(64, $smokeSnapshot.Length))))) { throw 'The verification capability leaked into the repository account environment; verification was stopped.' }
  Remove-Item -LiteralPath 'C:\work\isolation-check' -Recurse -Force
  Expand-Variant 'C:\work\baseline' $snapshot['baseline'] 'mzbaseline'
  Expand-Variant 'C:\work\candidate' $snapshot['candidate'] 'mzcandidate'
  $state = @{ missing = @(); failures = @(); baselineAudit = @() }
  Invoke-Variant 'baseline' @($snapshot['baseline']) $baselineUser $tools $report $state
  Invoke-Variant 'candidate' @($snapshot['candidate']) $candidateUser $tools $report $state
  if ($state.failures.Count) { $report.status = 'failed'; $report.reason = (($state.failures -join ' ') + $(if ($state.missing.Count) { " Missing prerequisites: $($state.missing -join '; ')." } else { '' }) + ' Approval remains blocked.') }
  elseif ($state.missing.Count) { $report.status = 'unsupported'; $report.reason = "Available checks completed, but required checks were not executed: $($state.missing -join '; '). Add the missing tests, then verify again. Approval remains blocked." }
  else { $report.status = 'passed'; $report.reason = $(if ($state.baselineAudit.Count) { 'Baseline and candidate install, build and tests passed. Candidate dependency audit passed; pre-existing baseline vulnerabilities are retained as diagnostics. Human review remains required.' } else { 'Baseline and candidate dependency installation, build/compilation, tests and dependency audit completed successfully for all detected projects. Human review remains required; this does not prove complete behavioral equivalence.' }) }
  if ($report.reason.Length -gt 2000) { $report.reason = $report.reason.Substring(0, 2000) }
  Publish-Report $report $true
} catch {
  $message = [string]$_.Exception.Message
  if ($message.Length -gt 2000) { $message = $message.Substring(0, 2000) }
  try { Publish-Report @{ status = 'failed'; reason = $message; steps = $report.steps } $true } catch {}
  Write-Error $message
  exit 1
}
