# Works on Windows PowerShell 5.x (no `&&` required). Usage: .\run.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
pip install -r requirements.txt -q
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
