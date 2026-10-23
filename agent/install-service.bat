@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:: Yeu cau quyen Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Vui long chay file bang quyen Administrator.
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "SERVICE_NAME=CCCDLocalAgent"
:: Bo dau "\" cuoi cua %~dp0: chuoi "C:\dir\" lam NSSM hieu \" la dau nhay => AppDirectory sai
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"
set "APP=%APP_DIR%\CCCD-Agent.exe"
set "NSSM=%APP_DIR%\nssm.exe"
set "LOG_DIR=%APP_DIR%\logs"
set "STATUS_URL=http://127.0.0.1:3000/api/status"

if not exist "%APP%" (
    echo [ERROR] Khong tim thay CCCD-Agent.exe
    pause
    exit /b 1
)

if not exist "%NSSM%" (
    echo [ERROR] Khong tim thay nssm.exe
    pause
    exit /b 1
)

if not exist "%APP_DIR%\portable\run.cmd" (
    echo [ERROR] Khong tim thay portable\run.cmd. Giu nguyen thu muc portable canh CCCD-Agent.exe.
    pause
    exit /b 1
)

:: read-cccd-chip.exe can .NET 8 Runtime (x64)
if not exist "%ProgramFiles%\dotnet\shared\Microsoft.NETCore.App\8.*" (
    echo [ERROR] Chua cai .NET 8 Runtime x64.
    echo Tai tai: https://dotnet.microsoft.com/download/dotnet/8.0
    pause
    exit /b 1
)

sc.exe query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% equ 0 (
    echo Service da ton tai. Dang go ban cu de cai lai...
    "%NSSM%" stop "%SERVICE_NAME%" >nul 2>&1
    "%NSSM%" remove "%SERVICE_NAME%" confirm
    if errorlevel 1 (
        echo [ERROR] Khong the go Service cu. Dong cua so Services ^(services.msc^) roi chay lai.
        pause
        exit /b 1
    )
    ping -n 3 127.0.0.1 >nul
)

:: Agent chay tay ^(CMD^) dang giu cong 3000 se lam Service loi lien tuc
netstat -ano | findstr /r /c:"127\.0\.0\.1:3000 .*LISTENING" >nul
if %errorlevel% equ 0 (
    echo [ERROR] Cong 3000 dang duoc su dung. Hay tat CCCD-Agent.exe dang chay tay roi chay lai.
    pause
    exit /b 1
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: SDK luu anh vao Desktop cua tai khoan chay Service ^(LocalSystem^).
:: Thu muc nay mac dinh khong ton tai, can tao de SDK va Agent dung cung duong dan.
if not exist "%SystemRoot%\System32\config\systemprofile\Desktop" mkdir "%SystemRoot%\System32\config\systemprofile\Desktop"

"%NSSM%" install "%SERVICE_NAME%" "%APP%"
if errorlevel 1 (
    echo [ERROR] Khong the tao Service.
    pause
    exit /b 1
)

call :nssm_set AppDirectory "%APP_DIR%" || goto :config_failed
call :nssm_set DisplayName "CCCD Local Agent" || goto :config_failed
call :nssm_set Description "Agent doc CCCD (HTTP/SSE 127.0.0.1:3000)" || goto :config_failed
call :nssm_set Start SERVICE_AUTO_START || goto :config_failed
call :nssm_set AppExit Default Restart || goto :config_failed
call :nssm_set AppRestartDelay 3000 || goto :config_failed
call :nssm_set AppStopMethodConsole 5000 || goto :config_failed
:: Khong dung AppStdout/AppRotate cua NSSM: NSSM 2.24-101 tao file log moi moi lan
:: Service khoi dong va bi treo STOP_PENDING khi bat AppRotateOnline.
:: CCCD-Agent.exe tu ghi logs\agent.log ^(toi da 5 MB, giu 5 file cu^).

:: nssm start co the bao SERVICE_START_PENDING du Service van len binh thuong,
:: nen ket qua duoc xac nhan bang API ben duoi.
"%NSSM%" start "%SERVICE_NAME%"

echo.
echo Dang kiem tra Agent tai %STATUS_URL% ...
powershell -NoProfile -Command "$s=$null; for($i=0;$i -lt 30;$i++){ try { $s=Invoke-RestMethod '%STATUS_URL%' -TimeoutSec 2 } catch {}; if($s -and $s.readerStatus -eq 'waiting'){ break }; Start-Sleep 1 }; if(-not $s){ exit 2 }; Write-Host ('API OK. readerStatus = ' + $s.readerStatus); if($s.readerStatus -ne 'waiting'){ exit 1 }"
set "CHECK=%errorlevel%"

echo.
if "%CHECK%"=="2" (
    echo [ERROR] Service da chay nhung API khong phan hoi.
    echo Kiem tra log: %LOG_DIR%\agent.log
    pause
    exit /b 1
)
if "%CHECK%"=="1" (
    echo [WARNING] Agent da chay nhung dau doc CCCD chua san sang.
    echo Kiem tra may doc da cam USB va xem log: %LOG_DIR%\agent.log
    pause
    exit /b 0
)

echo Da cai dat va khoi dong CCCD Local Agent. Dau doc CCCD dang cho the.
pause
exit /b 0

:nssm_set
"%NSSM%" set "%SERVICE_NAME%" %* >nul
exit /b %errorlevel%

:config_failed
echo [ERROR] Cau hinh Service that bai. Dang go Service vua tao...
"%NSSM%" remove "%SERVICE_NAME%" confirm >nul 2>&1
pause
exit /b 1
