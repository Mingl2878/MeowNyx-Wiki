# Isolated tests for release guards; no build, application or capture launch.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$path=Join-Path $PSScriptRoot 'release.ps1'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only function definitions, never the release script's executable body.
foreach ($node in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    . ([ScriptBlock]::Create($node.Extent.Text))
}
function Expect-Rejection([scriptblock]$action,[string]$label) {
    $rejected=$false
    try { & $action } catch { $rejected=$true }
    if (-not $rejected) { throw "Guard did not reject: $label" }
}
foreach ($name in @('data/user-config.json','data/battle-records.sqlite','rkpp/Key/session.txt','rkpp/runs/account.csv','assets/capture.pcap','data/monsters.json','rkpp/local/venv/bin/activate')) {
    Expect-Rejection { Assert-PublicFile $name } $name
}
foreach ($name in @('css/user-config.css','js/user-config.js','js/pages/battle-records.js','data/catalog.json','assets/monster/user-20261105-approved.webp','rkpp/source/rkpp_data.sqlite','rkpp/python/Lib/venv/scripts/common/activate','rkpp/source/LICENSE')) {
    Assert-PublicFile $name
}
Expect-Rejection { Assert-ReleaseMode $true $false } 'default release gate with unresolved blockers'
Assert-ReleaseMode $true $true
Assert-ReleaseMode $false $false
$expected=@{'data/catalog.json'=[ordered]@{bytes=3;sha256=('a'*64)}}
Assert-SameInventory $expected $expected 'same'
Expect-Rejection { Assert-SameInventory @{} $expected 'missing' } 'missing file'
Expect-Rejection { Assert-SameInventory @{'data/catalog.json'=[ordered]@{bytes=3;sha256=('b'*64)}} $expected 'changed' } 'changed SHA256'
# Prove real hashing without touching project or AppData files.
$test=Join-Path ([IO.Path]::GetTempPath()) ('meownyx-release-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $test | Out-Null
try {
    [IO.File]::WriteAllText((Join-Path $test 'public.txt'),'abc',(New-Object Text.UTF8Encoding($false)))
    $inventory=Get-Inventory $test
    if ($inventory.Count -ne 1 -or $inventory['public.txt'].bytes -ne 3 -or $inventory['public.txt'].sha256 -ne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') { throw 'Inventory bytes/SHA256 failed' }
    Assert-SameInventory $inventory $inventory 'real inventory'
} finally {
    $resolved=[IO.Path]::GetFullPath($test)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notmatch '^meownyx-release-test-[a-f0-9]{32}$') { throw 'Unsafe test cleanup target' }
    Assert-PlainPath $resolved
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
'PASS: release script AST, public/private guards, exact inventory, SHA256 and isolated cleanup.'
