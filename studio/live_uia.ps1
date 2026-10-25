param(
  [ValidateSet('dump', 'click')]
  [string]$Action = 'dump',
  [string]$Pattern = '开始直播|开播|开始直播！'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.WriteLine($json)
}

try {
  $proc = Get-Process -Name 'livehime' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) {
    Write-Result @{ ok = $false; error = '直播姬没有可见主窗口'; code = 'NO_WINDOW' }
    exit 0
  }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if (-not $root) {
    Write-Result @{ ok = $false; error = '读不到直播姬窗口'; code = 'NO_ELEMENT' }
    exit 0
  }

  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button
  )
  $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  $list = @()
  for ($i = 0; $i -lt $buttons.Count; $i++) {
    $item = $buttons.Item($i)
    $name = $item.Current.Name
    if ($name) { $list += $name }
  }

  if ($Action -eq 'dump') {
    Write-Result @{ ok = $true; window = $proc.MainWindowTitle; buttons = $list }
    exit 0
  }

  $match = $list | Where-Object { $_ -match $Pattern } | Select-Object -First 1
  if (-not $match) {
    Write-Result @{ ok = $false; error = "没找到匹配按钮：$Pattern"; buttons = $list; code = 'NO_BUTTON' }
    exit 0
  }

  for ($i = 0; $i -lt $buttons.Count; $i++) {
    $item = $buttons.Item($i)
    if ($item.Current.Name -eq $match) {
      $patternObj = $null
      if ($item.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$patternObj)) {
        $patternObj.Invoke()
        Write-Result @{ ok = $true; clicked = $match }
        exit 0
      }
      Write-Result @{ ok = $false; error = '按钮不支持 Invoke'; clicked = $null; code = 'NO_INVOKE' }
      exit 0
    }
  }
  Write-Result @{ ok = $false; error = '按钮列表变化，没点'; code = 'STALE' }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message; code = 'UIA_ERROR' }
  exit 0
}
