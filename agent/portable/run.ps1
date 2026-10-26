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

    # Thu vien native co the in khong xuong dong, lam dong cua SDK .NET bi dinh vao sau
    # mot dong nhieu. Khong loai bo dong co noi dung cua SDK: "...CCCD...", "Folder anh:",
    # "- <Truong>:", "[yyyy-MM-dd HH:mm:ss] ...", "San sang doc the", "Nhac the ra", "Loi doc the".
    if ($Line -match 'CCCD[ :.]|Folder |- [^\s:][^:]{0,30}:|\[\d{4}-\d{2}-\d{2} |S\u1EB5n s\u00E0ng|Nh\u1EA5c th\u1EBB|L\u1ED7i ') {
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
        [ref] $Position,
        [switch] $Final
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($stream.Length -le $Position.Value) {
            return
        }
        [void] $stream.Seek($Position.Value, [System.IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] ($stream.Length - $Position.Value)
        $read = 0
        while ($read -lt $buffer.Length) {
            $n = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
    }
    finally {
        $stream.Dispose()
    }

    # Chi in den dong da ket thuc (byte 0x0A). Phan dong dang ghi do se doc o lan sau,
    # tranh cat doi dong du lieu the hoac cat giua mot ky tu UTF-8.
    $count = $read
    if (-not $Final) {
        $count = [Array]::LastIndexOf($buffer, [byte]10, $read - 1) + 1
    }
    if ($count -le 0) {
        return
    }
    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count)
    $Position.Value += $count

    foreach ($line in ($text -split '\r?\n')) {
        if (-not (Test-NativeNoise $line)) {
            Write-Host $line
        }
    }
}

$sdkArgs = @("--sdk-root", "`"$sdkRoot`"")
# Agent truyen thu muc luu anh tuyet doi. Khong co bien nay, SDK luu vao Desktop
# cua tai khoan dang chay (LocalSystem: C:\Windows\System32\config\systemprofile\Desktop).
if ($env:CCCD_DESKTOP_ROOT) {
    $sdkArgs += @("--desktop-root", "`"$($env:CCCD_DESKTOP_ROOT.TrimEnd('\'))`"")
}

$process = Start-Process `
    -FilePath $exe `
    -ArgumentList $sdkArgs `
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

Write-FilteredLines -Path $stdoutLog -Position ([ref] $stdoutPosition) -Final
Write-FilteredLines -Path $stderrLog -Position ([ref] $stderrPosition) -Final
Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
exit 0
