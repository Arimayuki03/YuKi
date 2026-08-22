# 从 assets/icon.png（1024x1024 像素风）生成托盘多尺寸图标。
# 最近邻插值保留像素硬边；DPI 分档：16(100%)/20(125%)/24(150%)/32(200%)。
# 用法：powershell -File scripts\make-tray-icons.ps1
param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot),
    [string]$Source = 'assets\icon.png',
    [int[]]$Sizes = @(16, 20, 24, 32)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$srcPath = Join-Path $Root $Source
$outDir = Join-Path $Root 'assets\tray'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$src = [System.Drawing.Bitmap]::new($srcPath)

foreach ($s in $Sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    # 最近邻：像素画缩放唯一正确方式，双三次会把硬边糊掉
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $out = Join-Path $outDir "tray-$s.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "tray-$s.png -> $out"
}
$src.Dispose()
