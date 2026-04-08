@echo off
chcp 65001 >nul
title FileMaker Data Workbench

echo.
echo  ================================
echo   FileMaker データ移行ツール
echo  ================================
echo.

:: 最新版に更新（git があれば）
where git >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  最新版を確認中...
    git pull --ff-only 2>nul
    echo.
)

:: 依存パッケージの確認
if not exist node_modules (
    echo  初回セットアップ中（少し時間がかかります）...
    call npm install
    echo.
)

:: 起動
echo  起動します...
echo.
echo  -----------------------------------------------
echo   同じネットワーク内の他のPCからもアクセスできます
echo   ブラウザで表示されるURLを開いてください
echo  -----------------------------------------------
echo.
echo  終了するにはこのウインドウを閉じてください
echo.

call npx tsx src/ui/server.ts --host 0.0.0.0
