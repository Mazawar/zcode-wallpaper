# Renders docs/icon.png (512x512) with GDI+ — the marketplace icon for
# zcode-wallpaper. Design (D32, minimalist): rounded square, indigo->violet
# vertical gradient, white sun, two white wave bands (the smallest possible
# "wallpaper" story). Must stay legible at 16px.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/render-icon.ps1 <out.png>
param([string]$OutPath = "docs/icon.png")

Add-Type -AssemblyName System.Drawing

$size = 512
$radius = 112
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# Rounded-rect clip: nothing may paint outside it (waves would poke square corners).
function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$frame = New-RoundedRect 0 0 $size $size $radius
$g.SetClip($frame)

# Vertical gradient: indigo -> violet.
$top = [System.Drawing.Color]::FromArgb(255, 79, 125, 249)
$bot = [System.Drawing.Color]::FromArgb(255, 139, 92, 246)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, $size)), $top, $bot)
$g.FillRectangle($brush, 0, 0, $size, $size)

# Sun.
$sunBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242, 255, 255, 255))
$g.FillEllipse($sunBrush, 280, 114, 112, 112)

# Back wave (soft), then front wave (solid). Each is two cubic beziers across
# the full width, closed to the bottom.
function Add-Wave([System.Drawing.Graphics]$gfx, [int]$alpha, [string]$c0y, [string]$c1y, [string]$c2y, [string]$c3y) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $y0 = [single]0
  $p.StartFigure()
  $p.AddBezier(
    (New-Object System.Drawing.Point(0, $c0y)),
    (New-Object System.Drawing.Point(90, $c1y)),
    (New-Object System.Drawing.Point(170, $c1y)),
    (New-Object System.Drawing.Point(256, $c2y)))
  $p.AddBezier(
    (New-Object System.Drawing.Point(256, $c2y)),
    (New-Object System.Drawing.Point(342, $c3y)),
    (New-Object System.Drawing.Point(422, $c3y)),
    (New-Object System.Drawing.Point(512, $c2y)))
  $p.AddLine(512, 512, 0, 512)
  $p.CloseFigure()
  $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
  $gfx.FillPath($b, $p)
}

Add-Wave $g 89 336 288 320 352 | Out-Null   # back wave: soft
Add-Wave $g 235 392 340 376 412 | Out-Null  # front wave: near-solid

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon written: $OutPath"
