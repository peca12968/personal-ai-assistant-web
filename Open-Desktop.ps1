param(
    [string]$AssistantRoot = 'F:\Projects\personal-ai-assistant',
    [int]$Port = 18765,
    [switch]$BridgeOnly
)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
$descriptor = Join-Path $runtime 'bridge.json'

function Test-Bridge {
    try {
        if (-not (Test-Path -LiteralPath $descriptor)) { return $false }
        $bridge = Get-Content -LiteralPath $descriptor -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($bridge.address -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}$' -or $bridge.key -notmatch '^[a-zA-Z0-9_-]{32,}$') { return $false }
        $result = Invoke-RestMethod -Uri ($bridge.address + '/api/status') -Headers @{Authorization="Bearer $($bridge.key)"} -TimeoutSec 2
        return $result.mode -in @('off','chat','training','stopping')
    } catch { return $false }
}

try {
    $siteKey = (Get-Content -LiteralPath (Join-Path $runtime 'site.key') -Raw -Encoding UTF8).Trim()
    if ($siteKey -notmatch '^[a-zA-Z0-9_-]{40,}$') { throw '找不到有效的 IIS 桌面連線設定。' }
    if (-not (Test-Bridge)) {
        $python = Join-Path $AssistantRoot '.venv\Scripts\pythonw.exe'
        if (-not (Test-Path -LiteralPath $python)) { throw '找不到 F 槽個人助理的本機環境。' }
        $bridgeArgs = '-m assistant.iis_bridge --runtime "' + $runtime + '"'
        Start-Process -FilePath $python -ArgumentList $bridgeArgs -WorkingDirectory $AssistantRoot -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(20)
        do {
            if (Test-Bridge) { break }
            Start-Sleep -Milliseconds 350
        } while ((Get-Date) -lt $deadline)
        if (-not (Test-Bridge)) { throw '本機助理尚未啟動，請檢查 F 槽執行環境。' }
    }
    if ($BridgeOnly) { return }
    $url = "http://127.0.0.1:$Port/#key=$siteKey"
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $edge = Join-Path $programs 'Microsoft\Edge\Application\msedge.exe'
    if (Test-Path -LiteralPath $edge) {
        Start-Process -FilePath $edge -ArgumentList "--app=$url"
    } else {
        Start-Process $url
    }
}
catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'個人 AI 助理') | Out-Null
    exit 1
}
