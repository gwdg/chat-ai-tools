@echo off
setlocal EnableExtensions

title Calendar MCP Server
set "CONFIG=%~dp0calendar.json"

if not exist "%CONFIG%" (
  echo Calendar config not found:
  echo   %CONFIG%
  echo.
  echo Copy calendar.json.example to calendar.json and edit it with your
  echo CalDAV URL, username, app password, and email address.
  echo.
  pause
  exit /b 1
)

echo.
echo Calendar MCP endpoint:
echo   http://127.0.0.1:8767/mcp
echo.
echo Config:
echo   %CONFIG%
echo.
echo Keep this window open while Chat AI uses the calendar.
echo Press Ctrl+C to stop.
echo.

"%~dp0calendar-mcp.exe" --http --config "%CONFIG%"

endlocal
