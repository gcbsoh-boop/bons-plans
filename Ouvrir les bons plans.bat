@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Recherche des bons plans...
echo   (cela prend quelques secondes)
echo.
node bons-plans.js >nul
if errorlevel 1 (
  echo   Oups : impossible de trouver les bons plans.
  echo   Verifiez votre connexion internet, ou que Node.js est installe.
  echo.
  pause
  exit /b 1
)
start "" "%~dp0bons-plans.html"
