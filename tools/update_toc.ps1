# Update the TOC field for real and save back. ASCII-only on purpose:
# PowerShell 5.1 reads BOM-less .ps1 as ANSI, so any CJK literal would be mangled.
$ErrorActionPreference = "Stop"

# "xin qing" = U+5FC3 U+60C5, built from code points to dodge encoding issues
$name = [string][char]0x5FC3 + [string][char]0x60C5 + ".docx"
$path = Join-Path ([Environment]::GetFolderPath("Desktop")) $name

if (-not (Test-Path -LiteralPath $path)) {
    Write-Output "MISSING: $path"
    exit 1
}
Write-Output "TARGET: $path"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($path, $false, $false)
    $tocCount = $doc.TablesOfContents.Count
    for ($i = 1; $i -le $tocCount; $i++) {
        $doc.TablesOfContents.Item($i).Update()
    }
    $doc.Fields.Update() | Out-Null
    $doc.Repaginate()

    $pages = $doc.ComputeStatistics(2)
    $words = $doc.ComputeStatistics(0)
    $chars = $doc.ComputeStatistics(3)

    if ($tocCount -gt 0) {
        Write-Output "--- TOC TEXT ---"
        Write-Output ($doc.TablesOfContents.Item(1).Range.Text)
        Write-Output "--- END TOC ---"
    }

    $doc.Save()
    $doc.Close($false)
    Write-Output "toc_count: $tocCount"
    Write-Output "pages: $pages"
    Write-Output "words: $words"
    Write-Output "chars: $chars"
} finally {
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    [GC]::Collect()
}
