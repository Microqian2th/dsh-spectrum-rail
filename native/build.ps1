# 重新编译 WASAPI 回环助手
# 用法：powershell -ExecutionPolicy Bypass -File native/build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  throw "csc.exe not found: $csc (install .NET Framework 4.x)"
}

& $csc /nologo /target:exe /platform:anycpu /out:loopback-capture.exe LoopbackCapture.cs
if ($LASTEXITCODE -ne 0) { throw "compile failed ($LASTEXITCODE)" }

$hash = (Get-FileHash .\loopback-capture.exe -Algorithm SHA256).Hash
Write-Host "built loopback-capture.exe"
Write-Host "sha256 $hash"
