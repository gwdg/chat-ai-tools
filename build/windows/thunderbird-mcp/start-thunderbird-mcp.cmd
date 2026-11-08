@echo off
setlocal EnableExtensions

title Thunderbird MCP Server
set "TOKEN_FILE=%~dp0token.txt"

if not exist "%TOKEN_FILE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[guid]::NewGuid().ToString('N'); Set-Content -LiteralPath '%TOKEN_FILE%' -Value $t -NoNewline -Encoding ASCII"
)

set "TOKEN="
for /f "usebackq delims=" %%T in ("%TOKEN_FILE%") do set "TOKEN=%%T"

if "%TOKEN%"=="" (
  echo Could not create or read the bearer token file:
  echo   %TOKEN_FILE%
  echo.
  pause
  exit /b 1
)

echo.
echo Thunderbird MCP endpoint:
echo   http://127.0.0.1:8765/mcp
echo.
echo Bearer token:
echo   %TOKEN%
echo.
echo Token file:
echo   %TOKEN_FILE%
echo.
echo Keep this window open while Chat AI uses the server.
echo Press Ctrl+C to stop.
echo.

set "THUNDERBIRD_MCP_PASSWORD=%TOKEN%"
"%~dp0thunderbird-mcp.exe" --http

endlocal
