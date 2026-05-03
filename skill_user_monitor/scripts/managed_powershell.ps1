param(
    [string]$SessionName = "powershell-session"
)

$ErrorActionPreference = "Continue"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $scriptRoot
$logsRoot = Join-Path $appRoot "logs"
New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null

function Get-SafeName {
    param([string]$Value)
    $safe = $Value -replace '[\\/:*?"<>|]', "_"
    if ([string]::IsNullOrWhiteSpace($safe)) {
        return "powershell-session"
    }
    return $safe
}

function ConvertTo-RedactedCommand {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return ""
    }

    $redacted = $CommandLine
    $patterns = @(
        '(?i)(--?(?:password|passwd|pwd|token|secret|api-key|apikey|api_key|access-token|refresh-token|authorization)\s+)(?:"[^"]*"|''[^'']*''|\S+)',
        '(?i)(--?(?:password|passwd|pwd|token|secret|api-key|apikey|api_key|access-token|refresh-token|authorization)=)(?:"[^"]*"|''[^'']*''|\S+)',
        '(?i)((?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|''[^'']*''|\S+)'
    )

    foreach ($pattern in $patterns) {
        $redacted = [regex]::Replace($redacted, $pattern, '${1}[REDACTED]')
    }

    $redacted = [regex]::Replace(
        $redacted,
        '(?i)\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b',
        '[REDACTED_TOKEN]'
    )
    return $redacted
}

function Get-CommandTokens {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return @()
    }

    $parseErrors = $null
    try {
        return @(
            [System.Management.Automation.PSParser]::Tokenize($CommandLine, [ref]$parseErrors) |
                Where-Object {
                    @("Command", "CommandArgument", "String", "Number", "Variable", "Member") -contains $_.Type.ToString()
                } |
                Select-Object -ExpandProperty Content
        )
    } catch {
        return @()
    }
}

function Get-CommandTokenDetails {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return @()
    }

    $parseErrors = $null
    try {
        return @(
            [System.Management.Automation.PSParser]::Tokenize($CommandLine, [ref]$parseErrors) |
                ForEach-Object {
                    [ordered]@{
                        content = $_.Content
                        type = $_.Type.ToString()
                        start = $_.Start
                        length = $_.Length
                        start_line = $_.StartLine
                        start_column = $_.StartColumn
                        end_line = $_.EndLine
                        end_column = $_.EndColumn
                    }
                }
        )
    } catch {
        return @()
    }
}

function Get-AstText {
    param($Ast)
    if ($null -eq $Ast -or $null -eq $Ast.Extent) {
        return ""
    }
    return $Ast.Extent.Text
}

function Get-AstSpan {
    param($Ast)
    if ($null -eq $Ast -or $null -eq $Ast.Extent) {
        return [ordered]@{}
    }
    return [ordered]@{
        start_offset = $Ast.Extent.StartOffset
        end_offset = $Ast.Extent.EndOffset
        start_line = $Ast.Extent.StartLineNumber
        start_column = $Ast.Extent.StartColumnNumber
        end_line = $Ast.Extent.EndLineNumber
        end_column = $Ast.Extent.EndColumnNumber
    }
}

function Get-CommandAstDetails {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) {
        return [ordered]@{
            parse_errors = @()
            statements = @()
            pipelines = @()
            commands = @()
        }
    }

    $tokens = $null
    $errors = $null
    try {
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($CommandLine, [ref]$tokens, [ref]$errors)
    } catch {
        return [ordered]@{
            parse_errors = @($_.Exception.Message)
            statements = @()
            pipelines = @()
            commands = @()
        }
    }

    $statementAsts = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.StatementAst]
    }, $true))
    $pipelineAsts = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.PipelineAst]
    }, $true))
    $commandAsts = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst]
    }, $true))

    $statements = @(
        for ($idx = 0; $idx -lt $statementAsts.Count; $idx++) {
            $item = $statementAsts[$idx]
            [ordered]@{
                index = $idx + 1
                text = Get-AstText -Ast $item
                span = Get-AstSpan -Ast $item
                ast_type = $item.GetType().Name
            }
        }
    )

    $pipelines = @(
        for ($idx = 0; $idx -lt $pipelineAsts.Count; $idx++) {
            $item = $pipelineAsts[$idx]
            [ordered]@{
                index = $idx + 1
                text = Get-AstText -Ast $item
                span = Get-AstSpan -Ast $item
                command_count = @($item.PipelineElements).Count
            }
        }
    )

    $commands = @(
        for ($idx = 0; $idx -lt $commandAsts.Count; $idx++) {
            $item = $commandAsts[$idx]
            $elements = @($item.CommandElements | ForEach-Object { Get-AstText -Ast $_ })
            [ordered]@{
                index = $idx + 1
                command_name = $item.GetCommandName()
                invocation_text = Get-AstText -Ast $item
                span = Get-AstSpan -Ast $item
                elements = $elements
                argument_text = @($elements | Select-Object -Skip 1)
                redirections = @($item.Redirections | ForEach-Object { Get-AstText -Ast $_ })
            }
        }
    )

    return [ordered]@{
        parse_errors = @($errors | ForEach-Object { $_.Message })
        statements = $statements
        pipelines = $pipelines
        commands = $commands
    }
}

function Get-ReferencedPaths {
    param([string[]]$Tokens)
    $paths = New-Object System.Collections.Generic.List[string]
    foreach ($token in $Tokens) {
        if ([string]::IsNullOrWhiteSpace($token) -or $token.StartsWith("-")) {
            continue
        }

        $clean = $token.Trim().Trim([char]34).Trim([char]39)
        $looksLikePath = (
            $clean -match '^[A-Za-z]:[\\/]' -or
            $clean -match '^[.]{1,2}[\\/]' -or
            $clean -match '[\\/]' -or
            $clean -match '\.(ps1|py|js|ts|tsx|json|md|txt|yml|yaml|toml|bat|cmd|csv|log)$'
        )

        if ($looksLikePath) {
            if ($clean.Length -gt 180) {
                $clean = $clean.Substring(0, 180)
            }
            $paths.Add($clean)
        }
    }
    return @($paths | Select-Object -First 8)
}

function Resolve-BatchPath {
    param(
        [string]$Value,
        [string]$WorkingDirectory
    )
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $clean = $Value.Trim().Trim([char]34).Trim([char]39)
    if ([string]::IsNullOrWhiteSpace($clean)) {
        return $null
    }

    $candidateValues = New-Object System.Collections.Generic.List[string]
    $candidateValues.Add($clean)
    if ([System.IO.Path]::GetExtension($clean) -eq "") {
        $candidateValues.Add("$clean.bat")
        $candidateValues.Add("$clean.cmd")
    }

    foreach ($candidate in $candidateValues) {
        $pathsToTry = New-Object System.Collections.Generic.List[string]
        if ([System.IO.Path]::IsPathRooted($candidate)) {
            $pathsToTry.Add($candidate)
        } else {
            $pathsToTry.Add((Join-Path $WorkingDirectory $candidate))
            foreach ($pathRoot in (($env:PATH -split ';') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
                $pathsToTry.Add((Join-Path $pathRoot $candidate))
            }
        }

        foreach ($pathToTry in $pathsToTry) {
            try {
                $resolved = Resolve-Path -LiteralPath $pathToTry -ErrorAction Stop
                $item = Get-Item -LiteralPath $resolved.Path -ErrorAction Stop
                if ($item.Extension.ToLowerInvariant() -in @(".bat", ".cmd")) {
                    return $item.FullName
                }
            } catch {
            }
        }
    }

    return $null
}

function Get-BatchLineKind {
    param([string]$Line)
    $trimmed = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return "blank"
    }
    $withoutAt = $trimmed.TrimStart("@")
    if ($withoutAt -match '^(?i:rem)(\s|$)' -or $withoutAt.StartsWith("::")) {
        return "comment"
    }
    if ($withoutAt.StartsWith(":")) {
        return "label"
    }
    if ($withoutAt -match '^(?i:echo)\s+') {
        return "echo"
    }
    if ($withoutAt -match '^(?i:set|setlocal|endlocal)(\s|$)') {
        return "environment"
    }
    if ($withoutAt -match '^(?i:if|for|goto|call|start|exit)(\s|$)') {
        return "control"
    }
    return "command"
}

function Get-BatchScriptDetails {
    param(
        [string]$CommandLine,
        [string]$WorkingDirectory,
        $AstDetails
    )

    $candidateValues = New-Object System.Collections.Generic.List[string]
    $tokens = @(Get-CommandTokens -CommandLine $CommandLine)
    foreach ($token in $tokens) {
        $candidateValues.Add($token)
    }

    if ($AstDetails -and $AstDetails["commands"]) {
        foreach ($command in @($AstDetails["commands"])) {
            if ($command["command_name"]) {
                $candidateValues.Add($command["command_name"])
            }
            foreach ($element in @($command["elements"])) {
                $candidateValues.Add($element)
            }
        }
    }

    $batchPaths = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in $candidateValues) {
        $resolved = Resolve-BatchPath -Value $candidate -WorkingDirectory $WorkingDirectory
        if ($resolved -and -not $batchPaths.Contains($resolved)) {
            $batchPaths.Add($resolved)
        }
    }

    return @(
        foreach ($batchPath in $batchPaths) {
            try {
                $item = Get-Item -LiteralPath $batchPath -ErrorAction Stop
                $lines = @(Get-Content -LiteralPath $batchPath -ErrorAction Stop)
                $lineItems = @(
                    for ($idx = 0; $idx -lt $lines.Count; $idx++) {
                        $raw = [string]$lines[$idx]
                        [ordered]@{
                            line_number = $idx + 1
                            raw = $raw
                            normalized = $raw.Trim().TrimStart("@")
                            kind = Get-BatchLineKind -Line $raw
                        }
                    }
                )
                [ordered]@{
                    path = $item.FullName
                    name = $item.Name
                    size_bytes = $item.Length
                    modified_at = $item.LastWriteTime.ToString("o")
                    line_count = $lines.Count
                    executable_line_count = @($lineItems | Where-Object { $_["kind"] -in @("command", "control", "environment") }).Count
                    lines = $lineItems
                }
            } catch {
                [ordered]@{
                    path = $batchPath
                    error = $_.Exception.Message
                }
            }
        }
    )
}

function Get-CommandInsight {
    param([string]$CommandLine)

    $tokens = @(Get-CommandTokens -CommandLine $CommandLine)
    $primary = ""
    if ($tokens.Count -gt 0) {
        $primary = [string]$tokens[0]
    }
    $primaryLower = $primary.ToLowerInvariant()
    $secondLower = if ($tokens.Count -gt 1) { ([string]$tokens[1]).ToLowerInvariant() } else { "" }

    $category = "general"
    $intent = "run terminal command"
    $mutatesFiles = $false
    $readsFiles = $false
    $networkLikely = $false

    switch -Regex ($primaryLower) {
        '^(cd|chdir|set-location)$' {
            $category = "navigation"; $intent = "change working directory"; break
        }
        '^(ls|dir|get-childitem|gci)$' {
            $category = "filesystem"; $intent = "list directory contents"; $readsFiles = $true; break
        }
        '^(cat|type|get-content|gc|more)$' {
            $category = "filesystem"; $intent = "read file contents"; $readsFiles = $true; break
        }
        '^(copy|copy-item|cp|move|move-item|mv|remove-item|rm|del|erase|new-item|ni|rename-item|ren|set-content|add-content|out-file)$' {
            $category = "filesystem"; $intent = "modify files or directories"; $mutatesFiles = $true; break
        }
        '^(rg|grep|select-string|findstr)$' {
            $category = "search"; $intent = "search text or files"; $readsFiles = $true; break
        }
        '^git$' {
            $category = "git"
            $intent = "run git operation"
            if ($secondLower -in @("add", "commit", "checkout", "merge", "rebase", "reset", "stash", "clean", "pull", "push", "apply")) {
                $mutatesFiles = $true
            }
            if ($secondLower -in @("status", "diff", "show", "log", "branch")) {
                $readsFiles = $true
            }
            if ($secondLower -in @("pull", "push", "fetch", "clone")) {
                $networkLikely = $true
            }
            break
        }
        '^(python|py|node|npm|pnpm|yarn|uv|pip|pytest|npx)$' {
            $category = "dev_tooling"; $intent = "run development tool or script"; $readsFiles = $true
            if ($primaryLower -in @("npm", "pnpm", "yarn", "pip", "uv", "npx")) {
                $networkLikely = $true
            }
            if ($secondLower -in @("install", "add", "remove", "uninstall", "build", "format", "lint", "test", "run")) {
                $mutatesFiles = $true
            }
            break
        }
        '^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)$' {
            $category = "network"; $intent = "access network resource"; $networkLikely = $true; break
        }
        default {
            if ($CommandLine -match '\|\s*(set-content|add-content|out-file)') {
                $category = "filesystem"; $intent = "write files through pipeline"; $mutatesFiles = $true
            }
            break
        }
    }

    return [ordered]@{
        primary_command = $primary
        command_category = $category
        intent = $intent
        argument_count = [Math]::Max(0, $tokens.Count - 1)
        referenced_paths = @(Get-ReferencedPaths -Tokens $tokens)
        mutates_files_likely = $mutatesFiles
        reads_files_likely = $readsFiles
        network_access_likely = $networkLikely
    }
}

function Get-TranscriptInfo {
    param([string]$TranscriptPath)
    if (-not (Test-Path -LiteralPath $TranscriptPath)) {
        return [ordered]@{
            path = $TranscriptPath
            size_bytes = 0
            updated_at = $null
        }
    }

    $item = Get-Item -LiteralPath $TranscriptPath
    return [ordered]@{
        path = $TranscriptPath
        size_bytes = $item.Length
        updated_at = $item.LastWriteTime.ToString("o")
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeSessionName = Get-SafeName $SessionName
$sessionDir = Join-Path $logsRoot ($safeSessionName + "-" + $stamp)
New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null

$metaPath = Join-Path $sessionDir "session.json"
$commandLogPath = Join-Path $sessionDir "commands.ndjson"
$transcriptPath = Join-Path $sessionDir "transcript.txt"

$sessionMeta = [ordered]@{
    session_name = $SessionName
    created_at = (Get-Date).ToString("o")
    shell = "powershell"
    host_user = $env:USERNAME
    host_name = $env:COMPUTERNAME
    working_directory = (Get-Location).Path
    recorder_mode = "managed_terminal"
    safety_mode = @{
        global_keylogging = $false
        password_capture = "raw terminal commands and transcript are captured if typed here"
        raw_command_capture = $true
        structured_command_redaction_available = $true
        stealth_background_collection = $false
        network_upload = $false
    }
    structured_fields = @(
        "command",
        "redacted_command",
        "token_details",
        "ast_details",
        "batch_scripts",
        "statement_count",
        "pipeline_count",
        "command_invocation_count",
        "primary_command",
        "command_category",
        "intent",
        "referenced_paths",
        "duration_ms",
        "cwd_before",
        "cwd_after",
        "transcript_size_bytes"
    )
}
$sessionMeta | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metaPath -Encoding UTF8

Start-Transcript -Path $transcriptPath -IncludeInvocationHeader | Out-Null
$host.UI.RawUI.WindowTitle = "Managed PowerShell recording - $SessionName"

$script:AppMonitorState = @{
    LastHistoryId = 0
    CommandSequence = 0
    LastPromptPath = (Get-Location).Path
    CommandLogPath = $commandLogPath
    MetaPath = $metaPath
    SessionName = $SessionName
    SessionDir = $sessionDir
    TranscriptPath = $transcriptPath
    LastTranscriptPosition = 0
}

function Read-CommandOutput {
    param([string]$TranscriptPath, [int]$FromPosition)
    if (-not (Test-Path -LiteralPath $TranscriptPath)) {
        return @{}
    }
    try {
        $content = Get-Content -LiteralPath $TranscriptPath -Raw -ErrorAction SilentlyContinue
        if ([string]::IsNullOrEmpty($content) -or $FromPosition -ge $content.Length) {
            return @{
                output_preview = ""
                output_size = 0
            }
        }
        $newContent = $content.Substring($FromPosition)
        $lines = $newContent -split "`n"
        $outputLines = @()
        $inOutput = $false
        foreach ($line in $lines) {
            if ($line -match "^\s*Command:.*|^\s*---------") {
                $inOutput = $false
                continue
            }
            if ($line.Trim() -match "^Output$") {
                $inOutput = $true
                continue
            }
            if ($inOutput -and $line.Trim() -ne "") {
                $outputLines += $line
            }
        }
        $maxPreviewLines = 20
        $preview = ($outputLines | Select-Object -First $maxPreviewLines) -join "`n"
        if ($outputLines.Count -gt $maxPreviewLines) {
            $preview += "`n... (truncated, total $($outputLines.Count) lines)"
        }
        $truncatedOutput = if ($preview.Length -gt 8000) { $preview.Substring(0, 8000) + "... (output truncated)" } else { $preview }
        return @{
            output_preview = $truncatedOutput
            output_size = $newContent.Length
            output_line_count = $outputLines.Count
        }
    } catch {
        return @{
            output_preview = ""
            output_size = 0
        }
    }
}

function Write-CommandRecord {
    param(
        [Parameter(Mandatory = $true)]
        [Microsoft.PowerShell.Commands.HistoryInfo]$HistoryItem,
        [Parameter(Mandatory = $true)]
        [string]$StartPath,
        [Parameter(Mandatory = $true)]
        [string]$EndPath,
        [bool]$Succeeded = $true,
        [AllowNull()]
        [int]$NativeExitCode,
        [AllowNull()]
        [string]$OutputPreview = $null
    )

    $durationMs = $null
    if ($HistoryItem.StartExecutionTime -and $HistoryItem.EndExecutionTime) {
        $durationMs = [int][Math]::Round(($HistoryItem.EndExecutionTime - $HistoryItem.StartExecutionTime).TotalMilliseconds)
    }

    $redactedCommand = ConvertTo-RedactedCommand -CommandLine $HistoryItem.CommandLine
    $insight = Get-CommandInsight -CommandLine $HistoryItem.CommandLine
    $tokenDetails = @(Get-CommandTokenDetails -CommandLine $HistoryItem.CommandLine)
    $astDetails = Get-CommandAstDetails -CommandLine $HistoryItem.CommandLine
    $batchScripts = @(Get-BatchScriptDetails -CommandLine $HistoryItem.CommandLine -WorkingDirectory $StartPath -AstDetails $astDetails)
    $transcriptInfo = Get-TranscriptInfo -TranscriptPath $script:AppMonitorState.TranscriptPath
    $script:AppMonitorState.CommandSequence += 1

    $record = [ordered]@{
        timestamp = (Get-Date).ToString("o")
        type = "terminal_command"
        shell = "powershell"
        sequence = $script:AppMonitorState.CommandSequence
        history_id = $HistoryItem.Id
        command = $HistoryItem.CommandLine
        redacted_command = $redactedCommand
        command_redacted = ($redactedCommand -ne $HistoryItem.CommandLine)
        command_raw_length = $HistoryItem.CommandLine.Length
        token_count = $tokenDetails.Count
        token_details = $tokenDetails
        ast_details = $astDetails
        batch_scripts = $batchScripts
        batch_script_count = $batchScripts.Count
        parse_errors = $astDetails["parse_errors"]
        statement_count = @($astDetails["statements"]).Count
        pipeline_count = @($astDetails["pipelines"]).Count
        command_invocation_count = @($astDetails["commands"]).Count
        primary_command = $insight["primary_command"]
        command_category = $insight["command_category"]
        intent = $insight["intent"]
        argument_count = $insight["argument_count"]
        referenced_paths = $insight["referenced_paths"]
        mutates_files_likely = $insight["mutates_files_likely"]
        reads_files_likely = $insight["reads_files_likely"]
        network_access_likely = $insight["network_access_likely"]
        execution_status = [string]$HistoryItem.ExecutionStatus
        succeeded = $Succeeded
        native_exit_code = $NativeExitCode
        started_at = if ($HistoryItem.StartExecutionTime) { $HistoryItem.StartExecutionTime.ToString("o") } else { $null }
        ended_at = if ($HistoryItem.EndExecutionTime) { $HistoryItem.EndExecutionTime.ToString("o") } else { $null }
        duration_ms = $durationMs
        cwd_before = $StartPath
        cwd_after = $EndPath
        cwd_changed = ($StartPath -ne $EndPath)
        transcript = $transcriptInfo
        output_preview = if ($OutputPreview) { $OutputPreview } else { "" }
    }

    $record | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $script:AppMonitorState.CommandLogPath -Encoding UTF8
}

Register-EngineEvent PowerShell.Exiting -Action {
    try {
        Stop-Transcript | Out-Null
    } catch {
    }
} | Out-Null

function global:prompt {
    $lastSucceeded = $?
    $lastExitCode = if ($null -ne $global:LASTEXITCODE) { [int]$global:LASTEXITCODE } else { $null }
    $currentPath = (Get-Location).Path

    $outputInfo = @{}
    if ($script:AppMonitorState.LastTranscriptPosition -gt 0) {
        $outputInfo = Read-CommandOutput -TranscriptPath $script:AppMonitorState.TranscriptPath -FromPosition $script:AppMonitorState.LastTranscriptPosition
    }

    $historyItem = Get-History -Count 1 -ErrorAction SilentlyContinue

    if ($historyItem -and $historyItem.Id -gt $script:AppMonitorState.LastHistoryId) {
        Write-CommandRecord `
            -HistoryItem $historyItem `
            -StartPath $script:AppMonitorState.LastPromptPath `
            -EndPath $currentPath `
            -Succeeded $lastSucceeded `
            -NativeExitCode $lastExitCode `
            -OutputPreview $outputInfo.output_preview
        $script:AppMonitorState.LastHistoryId = $historyItem.Id
    }

    $script:AppMonitorState.LastPromptPath = $currentPath
    if (Test-Path -LiteralPath $script:AppMonitorState.TranscriptPath) {
        $script:AppMonitorState.LastTranscriptPosition = (Get-Item -LiteralPath $script:AppMonitorState.TranscriptPath).Length
    }
    return "PS $currentPath> "
}

Write-Host ""
Write-Host "Managed PowerShell started." -ForegroundColor Cyan
Write-Host "Session directory: $sessionDir" -ForegroundColor DarkCyan
Write-Host "Command log: $commandLogPath" -ForegroundColor DarkCyan
Write-Host "Transcript: $transcriptPath" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "Notice: this window records raw commands, parsed subcommands/arguments/pipelines, and full screen output." -ForegroundColor Yellow
Write-Host "commands.ndjson also includes redacted_command as a helper field." -ForegroundColor Yellow
Write-Host "Avoid entering passwords, keys, or sensitive tokens here." -ForegroundColor Yellow
Write-Host ""
