# Ricava le icone piccole da icons/icon-512.png (Edge headless non sa rendere finestre sotto ~500px)
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $PSScriptRoot '..\icons'
$src = [System.Drawing.Image]::FromFile((Join-Path $dir 'icon-512.png'))
foreach ($pair in @(@('icon-192.png', 192), @('apple-touch-icon.png', 180))) {
  $bmp = New-Object System.Drawing.Bitmap $pair[1], $pair[1]
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $pair[1], $pair[1])
  $bmp.Save((Join-Path $dir $pair[0]), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ('creato icons/' + $pair[0])
}
$src.Dispose()
