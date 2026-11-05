# Build and verify only. Never starts the application, RKPP or an installer.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$Candidate)
$Candidate = $Candidate -or $env:RELEASE_CANDIDATE -eq '1'
$suffix = if ($Candidate) { '-Candidate-20261105' } else { '' }
$licenseStatus = if ($Candidate) { 'pending-confirmation-technical-candidate-only' } else { 'release-gate-passed-not-legal-advice' }
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$dist = [IO.Path]::GetFullPath((Join-Path $root 'dist'))
$app = Join-Path $dist 'app'
$utf8 = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-PlainPath([string]$path) {
    $item = Get-Item -LiteralPath $path -Force
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is forbidden: $($item.FullName)" }
        if ($item -is [IO.DirectoryInfo]) { $item = $item.Parent } else { $item = $item.Directory }
    }
}
function Get-Inventory([string]$path) {
    Assert-PlainPath $path
    $result = @{}
    foreach ($item in Get-ChildItem -LiteralPath $path -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is forbidden: $($item.FullName)" }
        if (-not $item.PSIsContainer) {
            $name = $item.FullName.Substring($path.TrimEnd('\').Length + 1).Replace('\','/')
            $result[$name] = [ordered]@{ file=$name; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
    }
    return $result
}
function Assert-SameInventory($actual, $expected, [string]$label) {
    if ($actual.Count -ne $expected.Count) { throw "$label file count differs: $($actual.Count) != $($expected.Count)" }
    foreach ($name in $expected.Keys) {
        if (-not $actual.ContainsKey($name)) { throw "$label missing file: $name" }
        if ($actual[$name].bytes -ne $expected[$name].bytes -or $actual[$name].sha256 -ne $expected[$name].sha256) { throw "$label bytes/hash differ: $name" }
    }
}
function Assert-PublicFile([string]$name) {
    if ($name -match '(^|/)(\.git|__pycache__|Key|runs|captures?|tests?|fixtures?|debug[^/]*|backups?)(/|$)' -or
        ($name -match '(^|/)(\.venv|venv)(/|$)' -and $name -notmatch '^rkpp/python/Lib/venv/') -or
        $name -match '(?i)\.(pcap|pcapng|log|csv|key|pem|pfx|sqlite(-wal|-shm)?|db|pyc)$' -and $name -ne 'rkpp/source/rkpp_data.sqlite' -or
        $name -match '(?i)(^|/)(user[-_]config[^/]*\.(json|sqlite|db)|rkpp_settings\.json|settings\.json|decoded_packets[^/]*|opencode_summary[^/]*|battle-records[^/]*\.(json|sqlite|db)|NIC[^/]*|\.env[^/]*|id_rsa[^/]*|monsters\.json|moves\.json|types\.json|wiki_monster_data\.json)$') {
        throw "Non-distributable file: $name"
    }
}
function Assert-WikiClosed {
    $processes = @(Get-Process | Where-Object { $_.ProcessName -match '小黑猫|MeowNyx' })
    if ($processes.Count) { throw "Wiki is still running (PID $($processes.Id -join ',')). Close it normally before packaging. No process will be terminated." }
}
function Assert-ReleaseMode([bool]$hasBlockers, [bool]$isCandidate) {
    if ($hasBlockers -and -not $isCandidate) { throw 'Public release is blocked by legal/RELEASE-BLOCKERS.md. Default mode cannot bypass this gate. Only an explicitly authorized -Candidate / RELEASE_CANDIDATE=1 technical candidate preserves unresolved notices.' }
}
function Write-Json([string]$path, $object) {
    [IO.File]::WriteAllText($path, ($object | ConvertTo-Json -Depth 20), $utf8)
}

try {
    Assert-PlainPath $root
    if ($dist -ne (Join-Path $root 'dist') -or $dist -eq $root) { throw 'Unsafe dist target' }
    if (Test-Path -LiteralPath $dist) { Assert-PlainPath $dist }
    $version = (Get-Content -LiteralPath (Join-Path $root 'version.txt') -Raw -Encoding UTF8).Trim()
    if ($version -notmatch '^\d+\.\d+(\.\d+)?$') { throw 'Invalid version.txt' }
    $iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Last 1
    if (-not $iscc) { throw 'Inno Setup 6 ISCC.exe is missing; both release artifacts are required. No installer will be downloaded.' }
    Get-Command go -ErrorAction Stop | Out-Null
    $catalog = Get-Content -LiteralPath (Join-Path $root 'data/catalog.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($catalog.schema_version -ne 2) { throw 'Release requires canonical catalog schema 2' }
    $ext = $catalog.PSObject.Properties['extensions']
    if ($null -ne $ext) {
        $choices = $ext.Value.PSObject.Properties['catalog_choices']
        if ($null -ne $choices -and $null -ne $choices.Value) {
            $choiceVersion = $choices.Value.PSObject.Properties['version']
            $choiceEntries = $choices.Value.PSObject.Properties['entries']
            if ($null -eq $choiceVersion -or $choiceVersion.Value -ne 1 -or $null -eq $choiceEntries -or $null -eq $choiceEntries.Value -or ($choiceEntries.Value | ConvertTo-Json -Compress -Depth 20) -ne '{}') { throw 'Factory catalog_choices must be known version 1 with an empty entries object; do not clear user strategies automatically.' }
        }
    }
    # Exact public RKPP manifest: launch.py and the manifest itself are the only extra files.
    $component = Join-Path $root 'rkpp'
    $manifest = Get-Content -LiteralPath (Join-Path $component 'distribution-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 'rkpp-local-component/1' -or -not $manifest.source_included -or $manifest.license -ne 'AGPL-3.0-only' -or -not $manifest.no_personal_keys_captures_settings_interfaces -or -not $manifest.no_driver_bundled_or_installed) { throw 'RKPP release manifest contract differs' }
    $rkpp = Get-Inventory $component
    $expectedRkpp = @{}
    foreach ($entry in $manifest.files) {
        $name = [string]$entry.file
        if ($name -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or $expectedRkpp.ContainsKey($name) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Invalid RKPP manifest path/hash: $name" }
        Assert-PublicFile "rkpp/$name"
        $expectedRkpp[$name] = $entry
    }
    foreach ($name in @('launch.py','distribution-files.json')) {
        if (-not $rkpp.ContainsKey($name)) { throw "RKPP missing $name" }
        $expectedRkpp[$name] = $rkpp[$name]
    }
    Assert-SameInventory $rkpp $expectedRkpp 'RKPP source manifest'
    foreach ($name in @('python/python.exe','python/pythonw.exe','python/python312.dll','python/Lib/os.py','python/Lib/encodings/__init__.py','python/LICENSE.txt','source/rkpp_data.sqlite','source/LICENSE','source/NOTICE')) {
        if (-not $rkpp.ContainsKey($name)) { throw "RKPP required file missing: $name" }
    }
    $source = @{}
    $dataNames = @('catalog.json','game-descriptions.json','default-battle-rules.json','battle-protocol-skills.json','battle-user-confirmed-skills.json')
    foreach ($folder in @('data','assets','css','js','legal')) {
        $tree = Get-Inventory (Join-Path $root $folder)
        if ($folder -eq 'data' -and (($tree.Count -ne $dataNames.Count) -or @($dataNames | Where-Object { -not $tree.ContainsKey($_) }).Count)) { throw 'Unexpected data files; release requires only the five approved public JSON files' }
        foreach ($name in $tree.Keys) {
            $relative = "$folder/$name"
            Assert-PublicFile $relative
            $source[$relative] = $tree[$name]
        }
    }
    foreach ($name in $rkpp.Keys) { $source["rkpp/$name"] = $rkpp[$name] }
    foreach ($name in @('index.html')) {
        $item = Get-Item -LiteralPath (Join-Path $root $name)
        Assert-PlainPath $item.FullName
        $source[$name] = [ordered]@{ file=$name; bytes=$item.Length; sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    Write-Host "Input integrity checked: $($source.Count) files; RKPP manifest: $($manifest.files.Count) entries. Version: $version. This is not release approval."
    foreach ($name in @('legal/THIRD-PARTY-NOTICES.md','legal/RKPP-MODIFICATIONS.md','legal/Apache-2.0.txt','legal/license-sources.json','legal/TECHNICAL-CANDIDATE.md')) {
        if (-not $source.ContainsKey($name)) { throw "Required legal notice missing: $name" }
    }
    $legalIndex = Get-Content -LiteralPath (Join-Path $root 'legal/license-sources.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($legalIndex.format -ne 'meownyx-legal-sources/1') { throw 'Unknown legal source index format' }
    foreach ($entry in $legalIndex.files) {
        $name='legal/'+$entry.file
        if (-not $source.ContainsKey($name) -or $source[$name].bytes -ne $entry.bytes -or $source[$name].sha256 -ne $entry.sha256) { throw "Legal original/extracted file hash differs: $name" }
    }
    if ($CheckOnly) { Write-Host "Check only (candidate=$Candidate): no application, backup, cleanup or build was started. Legal original/extracted notices checked: $($legalIndex.files.Count)."; exit 0 }
    Assert-ReleaseMode (Test-Path -LiteralPath (Join-Path $root 'legal/RELEASE-BLOCKERS.md')) ([bool]$Candidate)
    if ($Candidate) { Write-Warning 'TECHNICAL CANDIDATE ONLY: license questions remain unresolved; no compliant-public-release claim and no GitHub Release upload.' }
    Assert-WikiClosed
    # Keep evidence outside the project; callers supply the session-owned output directory.
    if (-not $env:RELEASE_REPORT_DIR) { throw 'Set RELEASE_REPORT_DIR to the session workspace release-publish-work directory.' }
    $reports = [IO.Path]::GetFullPath($env:RELEASE_REPORT_DIR).TrimEnd('\')
    if ($reports -eq $root -or $reports.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Release evidence must be outside the project' }
    New-Item -ItemType Directory -Path $reports -Force | Out-Null
    Assert-PlainPath $reports
    $backupParent = 'D:\echoagent\old\MeowNyx Wiki-backups'
    Assert-PlainPath $backupParent
    $backup = if ($env:RELEASE_BACKUP_DIR) { [IO.Path]::GetFullPath($env:RELEASE_BACKUP_DIR).TrimEnd('\') } else { Join-Path $backupParent ('release-packaging-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    if (-not $backup.StartsWith($backupParent + '\', [StringComparison]::OrdinalIgnoreCase) -or $backup -eq $backupParent) { throw 'Backup must be a new directory under the approved external backup root' }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Assert-PlainPath $backup
    if (Test-Path -LiteralPath $dist) {
        $old = Get-Inventory $dist
        $saved = Join-Path $backup 'dist'
        if (Test-Path -LiteralPath $saved) { throw 'Existing dist backup must not be overwritten; choose a fresh approved backup directory' }
        Copy-Item -LiteralPath $dist -Destination $saved -Recurse -Force
        Assert-SameInventory (Get-Inventory $saved) $old 'External full dist backup'
        Write-Json (Join-Path $reports 'previous-dist-backup.json') ([ordered]@{ backup=$saved; files=@($old.Values | Sort-Object file) })
        Assert-WikiClosed
        Assert-PlainPath $dist
        if ([IO.Path]::GetFullPath($dist) -ne (Join-Path $root 'dist')) { throw 'Unsafe cleanup target' }
        Write-Host "Verified cleanup target: $dist; verified backup: $saved"
        Remove-Item -LiteralPath $dist -Recurse -Force
    }
    New-Item -ItemType Directory -Path $app | Out-Null
    Write-Host '[1/4] Offline Go build (no application launch)'
    $env:GOPROXY='off'; $env:GOSUMDB='off'; $env:GOTOOLCHAIN='local'
    Push-Location $root
    try { & go build -ldflags '-H=windowsgui' -o (Join-Path $app '小黑猫 Wiki.exe') .; if ($LASTEXITCODE -ne 0) { throw "Go build failed: $LASTEXITCODE" } } finally { Pop-Location }
    Write-Host '[2/4] Copy only verified public files, runtime, corresponding source and legal notices'
    foreach ($name in $source.Keys) {
        $target = Join-Path $app $name
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $root $name) -Destination $target -Force
    }
    # Re-hash original inputs as well as copies; source changes during the build cannot slip through.
    foreach ($name in $source.Keys) {
        $item = Get-Item -LiteralPath (Join-Path $root $name)
        if ($item.Length -ne $source[$name].bytes -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $source[$name].sha256) { throw "Source changed during release build: $name" }
    }
    $expected = @{}
    foreach ($name in $source.Keys) { $expected[$name]=$source[$name] }
    if ($Candidate) {
        $marker='TECHNICAL-CANDIDATE.txt'
        Copy-Item -LiteralPath (Join-Path $root 'legal/TECHNICAL-CANDIDATE.md') -Destination (Join-Path $app $marker)
        $expected[$marker]=$source['legal/TECHNICAL-CANDIDATE.md']
    }
    $exe = Get-Item -LiteralPath (Join-Path $app '小黑猫 Wiki.exe')
    $expected[$exe.Name] = [ordered]@{ file=$exe.Name; bytes=$exe.Length; sha256=(Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    Assert-SameInventory (Get-Inventory $app) $expected 'Staged app'
    Write-Host '[3/4] Create and verify complete portable ZIP'
    $zipPath = Join-Path $dist "小黑猫Wiki-v$version-Portable$suffix.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($app, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    $zipInventory = @{}
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $name=$entry.FullName.Replace('\','/')
            Assert-PublicFile $name
            if ($zipInventory.ContainsKey($name)) { throw "Duplicate ZIP entry: $name" }
            $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
            try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose(); $sha.Dispose() }
            $zipInventory[$name]=[ordered]@{ file=$name; bytes=$entry.Length; sha256=$hash }
        }
    } finally { $archive.Dispose() }
    Assert-SameInventory $zipInventory $expected 'Portable ZIP'
    Write-Host '[4/4] Compile Inno Setup (do not run the installer)'
    Push-Location $root
    $setupBase="小黑猫Wiki-Setup-v$version$suffix"
    try { & $iscc "/F$setupBase" (Join-Path $root 'installer.iss'); if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed: $LASTEXITCODE" } } finally { Pop-Location }
    $setupPath=Join-Path $dist "$setupBase.exe"
    $artifacts=@(foreach ($path in @($zipPath,$setupPath,$exe.FullName)) {
        $file=Get-Item -LiteralPath $path
        if ($file.Length -le 0) { throw "Empty artifact: $path" }
        [ordered]@{ file=$file.FullName; bytes=$file.Length; sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    Assert-SameInventory (Get-Inventory $app) $expected 'Post-installer app'
    Write-Json (Join-Path $reports 'release-manifest.json') ([ordered]@{ format='meownyx-release/1'; version=$version; candidate=[bool]$Candidate; license_status=$licenseStatus; public_release_approved=$false; built_at=(Get-Date).ToString('o'); backup=$backup; app_file_count=$expected.Count; rkpp_manifest_file_count=$manifest.files.Count; zip_verified=$true; installer_compilation_verified=$true; application_or_capture_started=$false; artifacts=$artifacts; files=@(foreach($name in ($expected.Keys | Sort-Object)) { [ordered]@{file=$name;bytes=$expected[$name].bytes;sha256=$expected[$name].sha256} }) })
    Write-Host "Technical package integrity verified (candidate=$Candidate; license_status=$licenseStatus). Evidence: $(Join-Path $reports 'release-manifest.json')"
    $artifacts | Format-List
    exit 0
} catch {
    [Console]::Error.WriteLine("Release FAILED: $($_.Exception.Message)")
    exit 1
}
