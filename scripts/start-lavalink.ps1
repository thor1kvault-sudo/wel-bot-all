<#
.SYNOPSIS
  THOR APEX - Local Lavalink v4.2.2 Audio Server Launcher
.DESCRIPTION
  Checks Java runtime (Java 17+ / Java 21), automatically downloads the official
  Lavalink v4.2.2 JAR if missing, and launches the server using lavalink/application.yml.
#>

[CmdletBinding()]
param(
    [string]$Port = "2333",
    [string]$Memory = "1G",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  THOR APEX - Lavalink v4.2.2 Local Audio Server Launcher  " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Locate repository root and lavalink directory
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$LavalinkDir = Join-Path $RepoRoot "lavalink"
$JarPath = Join-Path $LavalinkDir "Lavalink.jar"
$ConfigPath = Join-Path $LavalinkDir "application.yml"
$DownloadUrl = "https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar"

if (-not (Test-Path $LavalinkDir)) {
    Write-Host "[ERROR] Lavalink directory not found at $LavalinkDir" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $ConfigPath)) {
    Write-Host "[ERROR] application.yml not found at $ConfigPath" -ForegroundColor Red
    exit 1
}

# Helper: Discover Java executable across PATH, JAVA_HOME, and standard install locations
function Get-JavaExecutable {
    # 1. Check if 'java' is in PATH
    $cmd = Get-Command java -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }

    # 2. Check via where.exe
    $whereOutput = (where.exe java 2>$null | Select-Object -First 1)
    if ($whereOutput -and (Test-Path $whereOutput)) {
        return $whereOutput
    }

    # 3. Check $env:JAVA_HOME
    if ($env:JAVA_HOME) {
        $jhJava = Join-Path $env:JAVA_HOME "bin\java.exe"
        if (Test-Path $jhJava) {
            return $jhJava
        }
    }

    # 4. Check common 64-bit and 32-bit installation directories
    $searchRoots = @(
        "$env:ProgramFiles\Eclipse Adoptium",
        "$env:ProgramFiles\Java",
        "$env:ProgramFiles\BellSoft",
        "$env:ProgramFiles\Amazon Corretto",
        "$env:ProgramFiles\Microsoft",
        "${env:ProgramFiles(x86)}\Java"
    )
    foreach ($root in $searchRoots) {
        if (Test-Path $root) {
            $found = Get-ChildItem -Path $root -Filter "java.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($found -and (Test-Path $found.FullName)) {
                return $found.FullName
            }
        }
    }

    return $null
}

# 2. Check Java installation and verify version
Write-Host ""
Write-Host "[1/4] Checking Java installation..." -ForegroundColor Yellow

$JavaExe = Get-JavaExecutable

if (-not $JavaExe) {
    Write-Host "[ERROR] Java was not found on your system." -ForegroundColor Red
    Write-Host "Please install OpenJDK 21 LTS (Temurin) and ensure java is available in your PATH or JAVA_HOME." -ForegroundColor Yellow
    Write-Host "Download: https://adoptium.net/temurin/releases/?version=21" -ForegroundColor Cyan
    exit 1
}

# Execute java -version cleanly via ProcessStartInfo to capture stderr without triggering PowerShell NativeCommandError
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $JavaExe
    $psi.Arguments = "-version"
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.WaitForExit()

    $JavaOutput = $proc.StandardError.ReadToEnd() + $proc.StandardOutput.ReadToEnd()
    if (-not $JavaOutput) {
        throw "Java -version output was empty"
    }

    $VersionLine = ($JavaOutput -split "`r?`n")[0].Trim()
    Write-Host "  -> Found: $JavaExe" -ForegroundColor DarkGray
    Write-Host "  -> Detected: $VersionLine" -ForegroundColor Green

    # Validate version is Java 17 or higher
    if ($JavaOutput -match 'version\s+"(\d+)') {
        $MajorVersion = [int]$Matches[1]
        if ($MajorVersion -lt 17) {
            Write-Host "[ERROR] Lavalink v4 requires Java 17 or higher. You have Java $MajorVersion." -ForegroundColor Red
            Write-Host "Please install Java 21 LTS from https://adoptium.net/" -ForegroundColor Yellow
            exit 1
        }
    }
} catch {
    Write-Host "[ERROR] Failed to execute $($JavaExe): $_" -ForegroundColor Red
    exit 1
}

# 3. Check for Lavalink.jar and download if missing
Write-Host ""
Write-Host "[2/4] Checking Lavalink.jar..." -ForegroundColor Yellow
if (Test-Path $JarPath) {
    $JarSize = (Get-Item $JarPath).Length / 1MB
    Write-Host "  -> Found existing Lavalink.jar ($([Math]::Round($JarSize, 2)) MB)" -ForegroundColor Green
} else {
    Write-Host "  -> Lavalink.jar missing. Downloading Lavalink v4.2.2 from GitHub Releases..." -ForegroundColor Cyan
    Write-Host "     Source: $DownloadUrl" -ForegroundColor DarkGray
    
    try {
        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe -L -o "$JarPath" "$DownloadUrl"
        } else {
            $ProgressPreference = "SilentlyContinue"
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $JarPath -UseBasicParsing
        }

        if (-not (Test-Path $JarPath) -or (Get-Item $JarPath).Length -lt 10MB) {
            throw "Downloaded Lavalink.jar file is missing or corrupted (< 10MB)."
        }
        $JarSize = (Get-Item $JarPath).Length / 1MB
        Write-Host "  -> Download complete! ($([Math]::Round($JarSize, 2)) MB)" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Failed to download Lavalink.jar: $_" -ForegroundColor Red
        if (Test-Path $JarPath) { Remove-Item $JarPath -Force -ErrorAction SilentlyContinue }
        exit 1
    }
}

# 4. Check port availability
Write-Host ""
Write-Host "[3/4] Checking port $Port availability..." -ForegroundColor Yellow
$PortInUse = $false
try {
    $Conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($Conn) {
        $PortInUse = $true
    }
} catch {}

if ($PortInUse) {
    Write-Host "  [WARN] Port $Port is currently in use. If Lavalink is already running, stop it first." -ForegroundColor Yellow
} else {
    Write-Host "  -> Port $Port is available." -ForegroundColor Green
}

if ($CheckOnly) {
    Write-Host "`n[SUCCESS] Prerequisites verified successfully! (CheckOnly mode)" -ForegroundColor Green
    exit 0
}

# 5. Launch Lavalink server
Write-Host ""
Write-Host "[4/4] Starting Lavalink v4.2.2 server..." -ForegroundColor Yellow
Write-Host "  Working Directory: $LavalinkDir" -ForegroundColor DarkGray
Write-Host "  Memory Allocation: -Xmx$Memory" -ForegroundColor DarkGray
Write-Host "  Press Ctrl + C anytime to stop the server." -ForegroundColor Cyan
Write-Host ""

# Push location to lavalink directory so relative paths in application.yml resolve cleanly
Push-Location $LavalinkDir
try {
    & $JavaExe "-Xmx$Memory" -jar Lavalink.jar
} finally {
    Pop-Location
}
