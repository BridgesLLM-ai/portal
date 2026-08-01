#Requires -Version 5.1
<#
  BridgesLLM Remote GPU setup for Windows.

  Ollama stays on its normal loopback endpoint. Tailscale owns the durable,
  tailnet-only TCP forward. There is no Node helper, pairing secret, scheduled
  task, custom service, or window that must remain open.
#>

[CmdletBinding()]
param(
    [switch] $RetireLegacyHelper,
    # Internal recursion guard for the one permitted UAC relaunch.
    [switch] $ElevationRelaunch
)

$script:SetupBuild = '20260726-native6'
$script:ServePort = 11435
$script:OllamaPort = 11434
$script:ServeTarget = 'tcp://127.0.0.1:11434'
$script:LegacyCleanupCommand = 'Start-Here.cmd --retire-legacy-helper'
$script:SetupSucceeded = $false
$script:ElevationExitCode = $null
$script:SkipClosePrompt = $false
$script:LegacyTaskName = 'BridgesLLM-OllamaTailnetHelper-v1'
$script:LegacyTaskMarker =
    '^version=[0-9]{1,4};generation=[1-9][0-9]{0,15};helperId=[A-Za-z0-9_-]{16,128}$'
$Host.UI.RawUI.WindowTitle = "BridgesLLM Remote GPU Setup ($($script:SetupBuild))"

function Write-Head([string] $Text) {
    Write-Host ''
    Write-Host "==== $Text ====" -ForegroundColor Cyan
}

function Write-Ok([string] $Text) {
    Write-Host "  [ OK ] $Text" -ForegroundColor Green
}

function Write-Need([string] $Text) {
    Write-Host "  [TODO] $Text" -ForegroundColor Yellow
}

function Write-Bad([string] $Text) {
    Write-Host "  [STOP] $Text" -ForegroundColor Red
}

function Test-Administrator {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
    return $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-ElevatedSetup {
    $ScriptPath = $PSCommandPath
    if (
        [string]::IsNullOrWhiteSpace($ScriptPath) `
        -or $ScriptPath -match '[\x00-\x1f\x7f"]'
    ) {
        throw 'The setup script path could not be resolved safely.'
    }
    $ScriptPath = [IO.Path]::GetFullPath($ScriptPath)
    if (
        $ScriptPath.StartsWith('\\') `
        -or $ScriptPath -notmatch '^[A-Za-z]:\\' `
        -or -not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)
    ) {
        throw 'Extract the setup zip to a local Windows drive before requesting Administrator rights.'
    }
    $PowerShellPath = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) {
        throw 'Windows PowerShell could not be resolved safely.'
    }

    $Arguments = @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ('"' + $ScriptPath + '"'),
        '-ElevationRelaunch'
    )
    if ($RetireLegacyHelper) {
        $Arguments += '-RetireLegacyHelper'
    }

    Write-Host ''
    Write-Need 'Administrator approval is required before this setup runs Tailscale Serve.'
    Write-Host '  Approve the one UAC prompt and continue in the Administrator window.' -ForegroundColor Yellow
    Write-Host '  This launcher waits for that exact setup result; it does not run a second setup.' -ForegroundColor DarkGray
    $Child = Start-Process `
        -FilePath $PowerShellPath `
        -ArgumentList $Arguments `
        -WorkingDirectory ([IO.Path]::GetDirectoryName($ScriptPath)) `
        -Verb RunAs `
        -Wait `
        -PassThru `
        -ErrorAction Stop
    return [int]$Child.ExitCode
}

function Resolve-Tailscale {
    $Command = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($Command) {
        return $Command.Source
    }
    foreach ($Candidate in @(
        'C:\Program Files\Tailscale\tailscale.exe',
        'C:\Program Files (x86)\Tailscale\tailscale.exe'
    )) {
        if (Test-Path -LiteralPath $Candidate) {
            return $Candidate
        }
    }
    return $null
}

function Invoke-Tailscale(
    [Parameter(Mandatory = $true)][string] $Executable,
    [Parameter(Mandatory = $true)][string[]] $Arguments
) {
    $Output = ''
    $ExitCode = 1
    try {
        $Output = (& $Executable @Arguments 2>&1 | Out-String).Trim()
        $ExitCode = $LASTEXITCODE
    } catch {
        $Output = $_.Exception.Message
        $ExitCode = 1
    }
    return [pscustomobject]@{
        ExitCode = $ExitCode
        Output = $Output
    }
}

function Find-TailscaleServeApprovalUrl([string] $Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }
    foreach ($Match in [regex]::Matches(
        $Text,
        'https://[^\x00-\x20\x7f''"<>]{1,2048}',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )) {
        $Candidate = $Match.Value.TrimEnd(
            [char[]]@('.', ',', ';', ':', ')', ']', '}')
        )
        try {
            $Uri = [Uri]$Candidate
            if (
                $Uri.Scheme -ceq 'https' `
                -and $Uri.Host -ceq 'login.tailscale.com' `
                -and [string]::IsNullOrEmpty($Uri.UserInfo) `
                -and $Uri.Port -eq 443
            ) {
                return $Uri.AbsoluteUri
            }
        } catch {
            continue
        }
    }
    return $null
}

function Write-TailscaleServeApprovalGuidance([string] $Output) {
    $ApprovalUrl = Find-TailscaleServeApprovalUrl $Output
    if ([string]::IsNullOrWhiteSpace($ApprovalUrl)) {
        return $false
    }
    Write-Need 'Tailscale requires one-time browser approval before this PC can use Serve.'
    Write-Host '  Open this exact Tailscale approval page while signed in to your tailnet:' -ForegroundColor Yellow
    Write-Host "  $ApprovalUrl" -ForegroundColor Cyan
    Write-Need 'Approve Serve there, then run Start-Here.cmd again. Nothing needs to remain open.'
    return $true
}

function Read-ServeForward(
    [Parameter(Mandatory = $true)][string] $Executable
) {
    $Status = Invoke-Tailscale $Executable @('serve', 'status', '--json')
    if ($Status.ExitCode -ne 0) {
        if ($Status.Output -match 'No serve config') {
            return [pscustomobject]@{
                Valid = $true
                Present = $false
                Forward = $null
                Scope = $null
                Detail = $Status.Output
            }
        }
        return [pscustomobject]@{
            Valid = $false
            Present = $false
            Forward = $null
            Scope = $null
            Detail = $Status.Output
        }
    }
    try {
        $Config = $Status.Output | ConvertFrom-Json -ErrorAction Stop
        $PortHandlers = @()
        $PortName = [string]$script:ServePort
        if ($null -ne $Config.TCP) {
            $PortProperty = $Config.TCP.PSObject.Properties[$PortName]
            if ($null -ne $PortProperty) {
                $PortHandlers += [pscustomobject]@{
                    Scope = 'device'
                    Handler = $PortProperty.Value
                }
            }
        }
        # Newer Tailscale versions can also report named Services in this
        # document. A Service-owned listener is not ours and must never be
        # overwritten by an unscoped device Serve command.
        if ($null -ne $Config.Services) {
            foreach ($ServiceProperty in $Config.Services.PSObject.Properties) {
                $Service = $ServiceProperty.Value
                if ($null -eq $Service -or $null -eq $Service.TCP) {
                    continue
                }
                $PortProperty = $Service.TCP.PSObject.Properties[$PortName]
                if ($null -ne $PortProperty) {
                    $PortHandlers += [pscustomobject]@{
                        Scope = "service:$($ServiceProperty.Name)"
                        Handler = $PortProperty.Value
                    }
                }
            }
        }
        if ($PortHandlers.Count -eq 0) {
            return [pscustomobject]@{
                Valid = $true
                Present = $false
                Forward = $null
                Scope = $null
                Detail = $Status.Output
            }
        }
        if ($PortHandlers.Count -ne 1) {
            return [pscustomobject]@{
                Valid = $false
                Present = $true
                Forward = $null
                Scope = $null
                Detail = "Multiple Tailscale Serve handlers use port $($script:ServePort)."
            }
        }
        $Forward = [string]$PortHandlers[0].Handler.TCPForward
        return [pscustomobject]@{
            Valid = -not [string]::IsNullOrWhiteSpace($Forward)
            Present = $true
            Forward = $Forward
            Scope = $PortHandlers[0].Scope
            Detail = $Status.Output
        }
    } catch {
        return [pscustomobject]@{
            Valid = $false
            Present = $false
            Forward = $null
            Scope = $null
            Detail = $_.Exception.Message
        }
    }
}

function Test-Ollama {
    try {
        $Response = Invoke-RestMethod `
            -Uri "http://127.0.0.1:$($script:OllamaPort)/api/version" `
            -TimeoutSec 5 `
            -ErrorAction Stop
        $Version = [string]$Response.version
        if ([string]::IsNullOrWhiteSpace($Version)) {
            throw 'Ollama returned no version.'
        }
        Write-Ok "Ollama is running on 127.0.0.1:$($script:OllamaPort) (version $Version)."
        return $true
    } catch {
        $Ollama = Get-Command ollama -ErrorAction SilentlyContinue
        if ($Ollama) {
            Write-Need 'Ollama is installed but is not answering. Open the Ollama app, then run this setup again.'
        } else {
            Write-Need 'Install Ollama from https://ollama.com/download, open it, then run this setup again.'
        }
        return $false
    }
}

function Resolve-IdentitySid([string] $Identity) {
    if ([string]::IsNullOrWhiteSpace($Identity)) {
        return $null
    }
    try {
        if ($Identity -match '^S-1-[0-9-]+$') {
            return (New-Object Security.Principal.SecurityIdentifier($Identity)).Value
        }
        return (
            (New-Object Security.Principal.NTAccount($Identity)).Translate(
                [Security.Principal.SecurityIdentifier]
            )
        ).Value
    } catch {
        return $null
    }
}

function Read-LegacyHelperResidue {
    $LocalAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (
        [string]::IsNullOrWhiteSpace($LocalAppData) `
        -or $LocalAppData.StartsWith('\\') `
        -or $LocalAppData -notmatch '^[A-Za-z]:\\'
    ) {
        return [pscustomobject]@{
            Valid = $false
            Present = $false
            Task = $null
            Folder = $null
            Files = @()
            Detail = 'The current user LocalAppData path could not be resolved safely.'
        }
    }

    $ExpectedFolder = [IO.Path]::GetFullPath(
        [IO.Path]::Combine(
            $LocalAppData,
            'BridgesLLM',
            'OllamaTailnetHelper'
        )
    )
    $Task = Get-ScheduledTask `
        -TaskName $script:LegacyTaskName `
        -TaskPath '\' `
        -ErrorAction SilentlyContinue
    if ($null -ne $Task) {
        $Actions = @($Task.Actions)
        $Action = if ($Actions.Count -eq 1) { $Actions[0] } else { $null }
        $Execute = if ($null -ne $Action) { [string]$Action.Execute } else { '' }
        $Arguments = if ($null -ne $Action) { [string]$Action.Arguments } else { '' }
        $ArgumentMatch = [regex]::Match(
            $Arguments,
            '^"(?<helper>[A-Za-z]:\\[^"\r\n]*\\ollama-tailnet-helper\.mjs)" --stored$'
        )
        $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $TaskSid = Resolve-IdentitySid ([string]$Task.Principal.UserId)
        if (
            [string]$Task.TaskPath -cne '\' `
            -or [string]$Task.Description -notmatch $script:LegacyTaskMarker `
            -or $null -eq $Action `
            -or [IO.Path]::GetFileName($Execute) -ine 'node.exe' `
            -or $Execute.StartsWith('\\') `
            -or $Execute -notmatch '^[A-Za-z]:\\' `
            -or -not $ArgumentMatch.Success `
            -or $TaskSid -cne $CurrentSid `
            -or [string]$Task.Principal.RunLevel -cne 'Limited'
        ) {
            return [pscustomobject]@{
                Valid = $false
                Present = $true
                Task = $null
                Folder = $ExpectedFolder
                Files = @()
                Detail = "A scheduled task named $($script:LegacyTaskName) exists, but its exact BridgesLLM ownership could not be proven. It was not changed."
            }
        }
    }

    $Files = @()
    if (Test-Path -LiteralPath $ExpectedFolder) {
        try {
            $FolderItem = Get-Item -LiteralPath $ExpectedFolder -Force -ErrorAction Stop
            if (
                -not $FolderItem.PSIsContainer `
                -or ($FolderItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
                -or [IO.Path]::GetFullPath($FolderItem.FullName) -cne $ExpectedFolder
            ) {
                throw 'The reserved legacy helper path is not an ordinary directory.'
            }
            foreach ($Item in @(Get-ChildItem -LiteralPath $ExpectedFolder -Force -ErrorAction Stop)) {
                $AllowedName = (
                    $Item.Name -ceq 'pairing-store.dpapi' `
                    -or $Item.Name -ceq '.pairing-store.lock' `
                    -or $Item.Name -match '^\.pairing-tmp-[a-f0-9]{24}$'
                )
                if (
                    $Item.PSIsContainer `
                    -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 `
                    -or -not $AllowedName `
                    -or [IO.Path]::GetDirectoryName(
                        [IO.Path]::GetFullPath($Item.FullName)
                    ) -cne $ExpectedFolder
                ) {
                    throw "The reserved legacy helper folder contains an unrecognized item: $($Item.Name)"
                }
                $Files += $Item.FullName
            }
        } catch {
            return [pscustomobject]@{
                Valid = $false
                Present = $true
                Task = $Task
                Folder = $ExpectedFolder
                Files = @()
                Detail = $_.Exception.Message + ' Nothing was removed.'
            }
        }
    }

    return [pscustomobject]@{
        Valid = $true
        Present = ($null -ne $Task -or (Test-Path -LiteralPath $ExpectedFolder))
        Task = $Task
        Folder = $ExpectedFolder
        Files = $Files
        Detail = $null
    }
}

function Remove-ExactLegacyHelperResidue {
    $Residue = Read-LegacyHelperResidue
    if (-not $Residue.Valid) {
        Write-Bad 'Legacy Remote GPU helper residue could not be identified safely.'
        Write-Host "  $($Residue.Detail)" -ForegroundColor DarkGray
        Write-Need 'Inspect that exact scheduled task or folder manually. Native setup stopped without changing Tailscale Serve.'
        return $false
    }
    if (-not $Residue.Present) {
        Write-Ok 'No legacy BridgesLLM Remote GPU helper task or state folder was found.'
        return $true
    }

    Write-Need 'The retired BridgesLLM Remote GPU helper was found on this PC.'
    if ($null -ne $Residue.Task) {
        Write-Host "  Scheduled task: $($script:LegacyTaskName)" -ForegroundColor DarkGray
    }
    if (Test-Path -LiteralPath $Residue.Folder) {
        Write-Host "  State folder: $($Residue.Folder)" -ForegroundColor DarkGray
    }
    Write-Host '  The native setup does not use this task, pairing state, or Node.js.' -ForegroundColor DarkGray
    Write-Need 'Continue only after the Portal shows this PC as the active native Remote GPU.'
    $Consent = Read-Host 'Type RETIRE to remove only these exact legacy BridgesLLM items, or press Enter to stop'
    if ($Consent.Trim().ToUpperInvariant() -cne 'RETIRE') {
        Write-Need 'Legacy helper cleanup was not authorized. Nothing was removed; the native listener remains configured.'
        return $false
    }

    try {
        if ($null -ne $Residue.Task) {
            Stop-ScheduledTask `
                -TaskName $script:LegacyTaskName `
                -TaskPath '\' `
                -ErrorAction SilentlyContinue
            Unregister-ScheduledTask `
                -TaskName $script:LegacyTaskName `
                -TaskPath '\' `
                -Confirm:$false `
                -ErrorAction Stop
            if (
                $null -ne (
                    Get-ScheduledTask `
                        -TaskName $script:LegacyTaskName `
                        -TaskPath '\' `
                        -ErrorAction SilentlyContinue
                )
            ) {
                throw 'The exact legacy scheduled task remained after removal.'
            }
            Write-Ok "Retired scheduled task $($script:LegacyTaskName)."
        }

        if (Test-Path -LiteralPath $Residue.Folder) {
            foreach ($File in $Residue.Files) {
                Remove-Item -LiteralPath $File -Force -ErrorAction Stop
            }
            Remove-Item -LiteralPath $Residue.Folder -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $Residue.Folder) {
                throw 'The exact legacy helper state folder remained after removal.'
            }
            Write-Ok 'Removed the exact legacy helper state folder.'
        }
        Write-Ok 'Legacy helper retirement is complete. No unrelated task, folder, or Tailscale rule was touched.'
        return $true
    } catch {
        Write-Bad ("Exact legacy helper cleanup failed: " + $_.Exception.Message)
        Write-Need 'Cleanup stopped. Re-run as Administrator; it will re-inspect the remaining exact residue without changing the native listener.'
        return $false
    }
}

function Main {
    Write-Host ''
    if ($RetireLegacyHelper) {
        Write-Host "BridgesLLM legacy helper retirement ($($script:SetupBuild))" -ForegroundColor White
        Write-Host 'This post-activation cleanup keeps the native Tailscale Serve listener in place.' -ForegroundColor DarkGray
    } else {
        Write-Host "BridgesLLM Remote GPU setup ($($script:SetupBuild))" -ForegroundColor White
        Write-Host 'This configures native Tailscale Serve. Nothing needs to stay open.' -ForegroundColor DarkGray
    }

    if ($env:OS -ne 'Windows_NT') {
        Write-Bad 'This setup file is for Windows. See README.txt for the equivalent Tailscale command.'
        return
    }

    Write-Head 'Tailscale'
    $Tailscale = Resolve-Tailscale
    if (-not $Tailscale) {
        Write-Need 'Install Tailscale from https://tailscale.com/download and sign in to the same tailnet as the Portal.'
        return
    }

    $Status = Invoke-Tailscale $Tailscale @('status')
    if (
        $Status.ExitCode -ne 0 `
        -or [string]::IsNullOrWhiteSpace($Status.Output) `
        -or $Status.Output -match 'Logged out|NeedsLogin|Stopped|not running'
    ) {
        Write-Need 'Open Tailscale and sign in to the same tailnet as the Portal, then run this setup again.'
        if ($Status.Output) {
            Write-Host "  $($Status.Output)" -ForegroundColor DarkGray
        }
        return
    }
    Write-Ok 'Tailscale is installed, running, and signed in.'

    Write-Head 'Ollama'
    if (-not (Test-Ollama)) {
        return
    }

    $LegacyResidue = $null
    if (-not $RetireLegacyHelper) {
        Write-Head 'Legacy helper transition'
        $LegacyResidue = Read-LegacyHelperResidue
        if (-not $LegacyResidue.Valid) {
            Write-Need 'Legacy helper residue could not be identified safely, so it was retained unchanged.'
            Write-Host "  $($LegacyResidue.Detail)" -ForegroundColor DarkGray
            Write-Host '  Native setup can continue without modifying that task or folder.' -ForegroundColor DarkGray
        } elseif ($LegacyResidue.Present) {
            Write-Need 'The legacy helper remains live until the native Portal connection is active.'
            Write-Host '  Existing Agent Chat continues through it until native Connect commits.' -ForegroundColor DarkGray
            Write-Host '  Native inventory, downloads, and model switching become available after Connect.' -ForegroundColor DarkGray
            Write-Host '  Setup performs no legacy task, state-folder, or pairing mutation.' -ForegroundColor DarkGray
        } else {
            Write-Ok 'No legacy BridgesLLM Remote GPU helper task or state folder was found.'
        }
    }

    Write-Head 'Private Remote GPU listener'
    $Existing = Read-ServeForward $Tailscale
    if (-not $Existing.Valid) {
        Write-Bad 'The existing Tailscale Serve configuration could not be read safely.'
        if ($Existing.Detail) {
            Write-Host "  $($Existing.Detail)" -ForegroundColor DarkGray
        }
        Write-Need 'Update Tailscale and run this setup again. No Serve rule was changed.'
        return
    }
    if (
        $Existing.Present `
        -and (
            $Existing.Scope -ne 'device' `
            -or $Existing.Forward -ne '127.0.0.1:11434'
        )
    ) {
        Write-Bad "Tailscale port $($script:ServePort) already belongs to another Serve rule."
        Write-Host "  Existing scope: $($Existing.Scope); target: $($Existing.Forward)" -ForegroundColor DarkGray
        Write-Need 'Choose a different product configuration before changing that existing rule. Nothing was overwritten.'
        return
    }

    if ($RetireLegacyHelper) {
        if (-not $Existing.Present) {
            Write-Bad "The exact native Tailscale listener on port $($script:ServePort) is not configured."
            Write-Need 'Run Start-Here.cmd normally and finish Connect in the Portal before retiring the legacy helper.'
            return
        }
        Write-Ok "Verified the exact device-owned TCP $($script:ServePort) listener to 127.0.0.1:$($script:OllamaPort)."
        Write-Head 'Post-activation legacy helper retirement'
        if (-not (Remove-ExactLegacyHelperResidue)) {
            return
        }
        Write-Ok 'The native Tailscale Serve listener remains configured and was not changed.'
        Write-Host 'To remove only that listener later:' -ForegroundColor DarkGray
        Write-Host "  tailscale serve --tcp=$($script:ServePort) off" -ForegroundColor DarkGray
        $script:SetupSucceeded = $true
        return
    }

    $ServeOutput = ''
    if (-not $Existing.Present) {
        $Serve = Invoke-Tailscale $Tailscale @(
            'serve',
            '--bg',
            "--tcp=$($script:ServePort)",
            $script:ServeTarget
        )
        $ServeOutput = $Serve.Output
        if ($Serve.ExitCode -ne 0) {
            Write-Bad 'Tailscale could not create the private listener.'
            if ($Serve.Output) {
                Write-Host "  $($Serve.Output)" -ForegroundColor DarkGray
            }
            if (-not (Write-TailscaleServeApprovalGuidance $Serve.Output)) {
                Write-Need 'If the message says permission was denied, right-click Start-Here.cmd, choose Run as administrator, and retry.'
            }
            return
        }
    } else {
        Write-Ok 'The exact private listener is already configured; no change was needed.'
    }

    $Verified = Read-ServeForward $Tailscale
    if (
        -not $Verified.Valid `
        -or -not $Verified.Present `
        -or $Verified.Scope -ne 'device' `
        -or $Verified.Forward -ne '127.0.0.1:11434'
    ) {
        Write-Bad 'Tailscale accepted the command but the exact listener could not be verified.'
        if ($Verified.Detail) {
            Write-Host "  $($Verified.Detail)" -ForegroundColor DarkGray
        }
        $ApprovalDetail = $ServeOutput + [Environment]::NewLine + $Verified.Detail
        if (-not (Write-TailscaleServeApprovalGuidance $ApprovalDetail)) {
            Write-Need 'Run this setup again. If it repeats, update Tailscale and retry.'
        }
        return
    }

    Write-Ok "Tailscale TCP $($script:ServePort) now forwards privately to Ollama on 127.0.0.1:$($script:OllamaPort)."
    Write-Ok 'Tailscale stores this configuration and restores it after reboots. This window may close.'

    $TailnetIp = Invoke-Tailscale $Tailscale @('ip', '-4')
    if ($TailnetIp.ExitCode -eq 0 -and $TailnetIp.Output -match '^100\.') {
        Write-Host "  Tailnet address: $($TailnetIp.Output.Trim())" -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host 'Return to the Portal:' -ForegroundColor Cyan
    Write-Host '  1. Settings -> AI Providers -> Remote GPU.'
    Write-Host '  2. Click Refresh devices and select this PC.'
    Write-Host '  3. Review the narrow Tailscale Grant, then click Connect.'
    Write-Host '  4. Browse and download a model. Real progress appears in the Portal.'
    if ($null -ne $LegacyResidue -and $LegacyResidue.Valid -and $LegacyResidue.Present) {
        Write-Host ''
        Write-Host 'After the Portal shows this PC as the active Remote GPU:' -ForegroundColor Yellow
        Write-Host "  $($script:LegacyCleanupCommand)" -ForegroundColor Yellow
        Write-Host 'This separate, explicit step retires only the exact legacy helper task and state.' -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host 'To remove only this listener later:' -ForegroundColor DarkGray
    Write-Host "  tailscale serve --tcp=$($script:ServePort) off" -ForegroundColor DarkGray
    $script:SetupSucceeded = $true
}

try {
    if (
        $env:OS -eq 'Windows_NT' `
        -and -not (Test-Administrator)
    ) {
        if ($ElevationRelaunch) {
            Write-Host ''
            Write-Bad 'The one-time UAC relaunch did not produce an Administrator token.'
            Write-Need 'Setup stopped instead of opening another window. Close this window and run Start-Here.cmd again.'
        } else {
            try {
                $script:ElevationExitCode = Invoke-ElevatedSetup
                # The elevated child already showed the result and owned the
                # one close prompt. Propagate its code without a duplicate
                # prompt in this waiting launcher.
                $script:SkipClosePrompt = $true
            } catch {
                Write-Host ''
                Write-Bad 'Windows Administrator approval was not granted.'
                Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
                Write-Need 'Nothing was changed by the elevation handoff. Run Start-Here.cmd again and approve the one UAC prompt.'
            }
        }
    } else {
        Main
    }
} catch {
    Write-Host ''
    Write-Bad ("Unexpected setup error: " + $_.Exception.Message)
    Write-Need 'No custom service or pairing secret was installed. You can safely run this setup again.'
} finally {
    if (-not $script:SkipClosePrompt) {
        Write-Host ''
        [void](Read-Host 'Press Enter to close this window')
    }
}

if ($null -ne $script:ElevationExitCode) {
    exit $script:ElevationExitCode
}

if ($script:SetupSucceeded) {
    exit 0
}
exit 1
