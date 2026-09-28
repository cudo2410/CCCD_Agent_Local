$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root "read-cccd-chip.exe"
$sdkRoot = Join-Path $root "IDE200_V3.0-Demo"
$logRoot = if ($env:TEMP) { $env:TEMP } else { $root }
$stdoutLog = Join-Path $logRoot "read-cccd-chip.stdout.log"
$stderrLog = Join-Path $logRoot "read-cccd-chip.stderr.log"

Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

function Test-NativeNoise {
    param([string] $Line)

    if ([string]::IsNullOrWhiteSpace($Line)) {
        return $false
    }

    $patterns = @(
        '^\s*<<',
        '^end of ',
        '^TMP_',
        '^---',
        '^Error\s*:\s*\d+',
        '^HC_',
        '^num_sub_template=',
        '^nType\s*=',
        '^after',
        '^\d+$',
        '^PRE$',
        '^LYT$',
        '^pModule=',
        '^imgw=',
        '^imgh=',
        '^index=',
        '^chanelnum=',
        '^set(height|width)=',
        '^PA_',
        '^Inpainting_',
        '^start crnn',
        '^thread \d+ start$',
        '^\d+,\d+,\d+,\d+,\d+,\d+setThreadNum=',
        '^dl_rec_',
        '^AddEnBlanks',
        '^tem_path=',
        '^tempname',
        '^X{4,}=',
        '^aveconf',
        '^has_j',
        '^mrz',
        '^DMN_Process',
        '^f{4,}',
        '^rc=',
        '^ret=',
        '^Reading count:',
        '^a{6,}',
        '^3{6,}',
        '^ss2='
    )

    foreach ($pattern in $patterns) {
        if ($Line -match $pattern) {
            return $true
        }
    }
    return $false
}

function Write-FilteredLines {
    param(
        [string] $Path,
        [ref] $Position
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        [void] $stream.Seek($Position.Value, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        try {
            $text = $reader.ReadToEnd()
            $Position.Value = $stream.Position
        }
        finally {
            $reader.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }

    if ($text.Length -eq 0) {
        return
    }

    foreach ($line in ($text -split '\r?\n')) {
        if (-not (Test-NativeNoise $line)) {
            Write-Host $line
        }
    }
}

$process = Start-Process `
    -FilePath $exe `
    -ArgumentList @("--sdk-root", "`"$sdkRoot`"") `
    -NoNewWindow `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$stdoutPosition = 0L
$stderrPosition = 0L
while (-not $process.HasExited) {
    Write-FilteredLines -Path $stdoutLog -Position ([ref] $stdoutPosition)
    Write-FilteredLines -Path $stderrLog -Position ([ref] $stderrPosition)
    Start-Sleep -Milliseconds 200
}

Write-FilteredLines -Path $stdoutLog -Position ([ref] $stdoutPosition)
Write-FilteredLines -Path $stderrLog -Position ([ref] $stderrPosition)
Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
exit 0
