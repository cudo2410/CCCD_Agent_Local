@echo off
setlocal EnableExtensions
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "SERVICE_NAME=CCCDLocalAgent"
set "NSSM=%~dp0nssm.exe"

if not exist "%NSSM%" (
    echo [ERROR] Khong tim thay nssm.exe
    pause
    exit /b 1
)

sc.exe query "%SERVICE_NAME%" >nul 2>&1
if %errorlevel% neq 0 (
    echo Service %SERVICE_NAME% khong ton tai.
    pause
    exit /b 0
)

"%NSSM%" stop "%SERVICE_NAME%"
"%NSSM%" remove "%SERVICE_NAME%" confirm
if errorlevel 1 (
    echo [ERROR] Khong the go Service. Dong cua so Services ^(services.msc^) roi chay lai.
    pause
    exit /b 1
)

:: Dung tien trinh SDK con sot lai trong thu muc nay ^(neu co^)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='read-cccd-chip.exe'\" | Where-Object { $_.ExecutablePath -like '%~dp0portable\*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Da go cai dat CCCD Local Agent Service.
pause
