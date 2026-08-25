Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:/Users/Administrator/Desktop/deeepseek/deepfusion/electron/anime-icon.png')
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$side = [Math]::Min($src.Width, $src.Height)
$x = [int](($src.Width - $side) / 2)
$y = [int](($src.Height - $side) / 2)
$rect = New-Object System.Drawing.Rectangle($x, $y, $side, $side)
$dest = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$g.DrawImage($src, $dest, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$bmp.Save('C:/Users/Administrator/Desktop/deeepseek/deepfusion/electron/icon-256.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$src.Dispose()
Write-Output 'OK icon-256.png saved'
