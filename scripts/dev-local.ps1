# DecisionCourt 本地开发一键启动脚本
#
# 用法（在项目根目录执行）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-local.ps1
#
# 做了三件事：
#   1. 用 Docker 起 Postgres（唯一依赖 Docker 的部分）
#   2. 新开一个窗口跑 Go 后端（:8080）
#   3. 新开一个窗口跑 Next.js 前端（:3000）
#
# 参数：
#   -NoBackend   只起数据库 + 前端
#   -NoFrontend  只起数据库 + 后端
#   -DbOnly      只起数据库（后端/前端自己在 IDE 里跑时用）

param(
    [switch]$NoBackend,
    [switch]$NoFrontend,
    [switch]$DbOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------- 0. 检查 Docker ----------
Write-Step "检查 Docker 守护进程"
$dockerOk = $false
try {
    $null = docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -eq 0) { $dockerOk = $true }
} catch { $dockerOk = $false }

if (-not $dockerOk) {
    Write-Host "Docker 守护进程没在运行。请先启动 Docker Desktop，等托盘图标不再转圈后重跑本脚本。" -ForegroundColor Yellow
    $exe = "C:\Users\$env:USERNAME\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
    if (Test-Path $exe) {
        $ans = Read-Host "要我现在帮你启动 Docker Desktop 吗？(y/N)"
        if ($ans -eq "y") {
            Start-Process $exe
            Write-Host "已发起启动，约需 30-90 秒。就绪后重跑本脚本。" -ForegroundColor Yellow
        }
    }
    exit 1
}
Write-Host "Docker OK: $(docker info --format '{{.ServerVersion}}')"

# ---------- 1. 数据库 ----------
Write-Step "启动 Postgres 容器 (dc_dev_postgres, 端口 5432)"
docker compose -f docker-compose.dev.yml up -d postgres

Write-Host "等待健康检查通过" -NoNewline
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    $status = docker inspect -f '{{.State.Health.Status}}' dc_dev_postgres 2>$null
    if ($status -eq "healthy") { break }
    Write-Host "." -NoNewline
}
if ($status -ne "healthy") {
    Write-Host "`nPostgres 启动异常，看日志：docker compose -f docker-compose.dev.yml logs postgres" -ForegroundColor Red
    exit 1
}
Write-Host " healthy"

if ($DbOnly) {
    Write-Host "`n数据库已就绪。后端/前端请自行启动。" -ForegroundColor Green
    exit 0
}

# ---------- 2. 后端 ----------
if (-not $NoBackend) {
    Write-Step "启动 Go 后端 (http://localhost:8080)"
    Start-Process powershell -ArgumentList `
        "-NoExit",
        "-Command",
        "Set-Location '$root\backend'; Write-Host 'DecisionCourt backend :8080' -ForegroundColor Green; go run ./cmd/server"
    Start-Sleep -Seconds 3
}

# ---------- 3. 前端 ----------
if (-not $NoFrontend) {
    Write-Step "启动 Next.js 前端 (http://localhost:3000)"
    # pnpm 11 会在 dev 前跑依赖检查，遇到未授权的构建脚本(unrs-resolver)直接退出 1，
    # 所以这里直接调 next.cmd 绕开那层检查。
    Start-Process powershell -ArgumentList `
        "-NoExit",
        "-Command",
        "Set-Location '$root\frontend'; `$env:NEXT_PUBLIC_API_URL='http://localhost:8080'; `$env:NEXT_PUBLIC_WS_URL='ws://localhost:8080'; `$env:NEXT_PUBLIC_USE_MOCK='false'; Write-Host 'DecisionCourt frontend :3000' -ForegroundColor Green; .\node_modules\.bin\next.cmd dev"
}

Write-Host @"

全部就绪：
  前端    http://localhost:3000
  后端    http://localhost:8080/health
  数据库  localhost:5432  (docker: dc_dev_postgres)

停止：
  docker compose -f docker-compose.dev.yml stop postgres   # 停数据库（保留数据）
  后端/前端窗口直接 Ctrl+C

首次启动提示：
  - Next.js 首次编译 20-60 秒，看到 Ready 后再刷新浏览器
  - 后端启动会自动建表，看到 "DecisionCourt backend listening" 即成功
"@ -ForegroundColor Green
