param(
    [string]$OwnerAccount = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [int]$Port = 18765
)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'runtime'
$deploy = Join-Path $PSScriptRoot 'deploy'
$site = 'PersonalAiAssistantWeb'
$appcmd = Join-Path $env:windir 'System32/inetsrv/appcmd.exe'
$binding = 'http/127.0.0.1:{0}:' -f $Port
$owner = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()

function Invoke-AppCmd([string[]]$Arguments) {
    $result = & $appcmd @Arguments 2>&1
    if ($LASTEXITCODE) { throw ('IIS {0} 結束碼 {1}。{2}' -f ($Arguments -join ' '), $LASTEXITCODE, ($result -join [Environment]::NewLine)) }
    $result
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
try {
    if (-not $owner.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '新增 IIS 站台需要使用 Windows 系統管理員執行。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $deploy 'PersonalAssistant.Web.dll'))) {
        throw '請先把 ASP.NET Core 專案發佈到 deploy 資料夾。'
    }
    if (-not (Test-Path -LiteralPath $appcmd)) { throw '找不到 IIS 的 appcmd。' }
    if ((Invoke-AppCmd @('list','module','/text:name')) -notcontains 'AspNetCoreModuleV2') {
        throw 'IIS 尚未註冊 ASP.NET Core Hosting Bundle 模組。'
    }
    $known = (Invoke-AppCmd @('list','site','/text:name')) -contains $site
    if ($known) {
        $currentRoot = Invoke-AppCmd @('list','vdir',"$site/",'/text:physicalPath')
        $currentBindings = Invoke-AppCmd @('list','site',$site,'/text:bindings')
        if ($currentRoot -ne $deploy -or $currentBindings -ne $binding) {
            throw '已有同名 IIS 站台，路徑或繫結不同。'
        }
    }
    $used = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($used -and -not $known) { throw "連接埠 $Port 已被其他服務使用。" }

    if ((Invoke-AppCmd @('list','apppool','/text:name')) -notcontains $site) {
        Invoke-AppCmd @('add','apppool',"/name:$site",'/managedRuntimeVersion:','/enable32BitAppOnWin64:false') | Out-Null
    }
    $principal = "IIS AppPool\$site"
    & icacls.exe $deploy /grant ('{0}:(OI)(CI)RX' -f $principal) | Out-Null
    if ($LASTEXITCODE) { throw '無法設定 IIS 站台權限。' }

    $key = Join-Path $runtime 'site.key'
    if (-not (Test-Path -LiteralPath $key)) {
        $bytes = New-Object byte[] 36
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        [IO.File]::WriteAllText($key,[Convert]::ToBase64String($bytes).Replace('/','_').Replace('+','-'))
    }
    & icacls.exe $runtime /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $OwnerAccount) ('{0}:(OI)(CI)RX' -f $principal) '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw '無法設定本機連線資料的讀取權限。' }

    $settingsFile = Join-Path $deploy 'appsettings.json'
    $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $settings.RuntimePath = $runtime
    $settings | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $settingsFile -Encoding UTF8
    if (-not $known) {
        Invoke-AppCmd @('add','site',"/name:$site","/bindings:$binding","/physicalPath:$deploy") | Out-Null
    }
    Invoke-AppCmd @('set','app',"$site/","/applicationPool:$site") | Out-Null
    if ((Invoke-AppCmd @('list','site',$site,'/text:state')) -ne 'Started') {
        Invoke-AppCmd @('start','site',$site) | Out-Null
    }

    $url = "http://127.0.0.1:$Port"
    $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 25
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'id="chat-power"') {
        throw 'IIS 站台回覆與預期介面不符。'
    }
    @{status='ready';url=$url;site=$site;verified=$page.StatusCode} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'iis-deploy.json') -Encoding UTF8
}
catch {
    @{status='failed';error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'iis-deploy.json') -Encoding UTF8
    throw
}
