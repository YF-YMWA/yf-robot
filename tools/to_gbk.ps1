# Convert .bat files from UTF-8 to GBK (codepage 936) so cmd.exe parses them correctly.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/to_gbk.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gbk = [System.Text.Encoding]::GetEncoding(936)
$utf8 = New-Object System.Text.UTF8Encoding($false)

Get-ChildItem -Path $root -Filter *.bat | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $raw = $utf8.GetString($bytes)
    # drop chcp line if present
    $raw = [regex]::Replace($raw, '(?m)^chcp 65001\s*>\s*nul\s*\r?\n', '')
    # normalize to CRLF
    $raw = $raw -replace "`r`n", "`n"
    $raw = $raw -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($_.FullName, $raw, $gbk)
    Write-Host ("converted: " + $_.Name)
}
