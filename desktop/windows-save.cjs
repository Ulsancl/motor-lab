const { spawn } = require('node:child_process');
const path = require('node:path');

// File.Replace uses ReplaceFileW with ACL merge errors enabled. The temporary
// file inherits a private DACL before receiving any project bytes.
const saveScript = String.raw`
$ErrorActionPreference = 'Stop'
$record = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [string]$record.target
$parent = [IO.Path]::GetDirectoryName($target)
$stage = [IO.Path]::Combine($parent, '.motor-save-' + [Guid]::NewGuid().ToString('N'))
$temporary = [IO.Path]::Combine($stage, 'project.tmp')
$backup = [IO.Path]::Combine($stage, 'previous.tmp')
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$reparsePoint = [IO.FileAttributes]::ReparsePoint

function Assert-RealDirectory([string]$directory) {
    while ($directory) {
        $attributes = [IO.File]::GetAttributes($directory)
        if (($attributes -band $reparsePoint) -or -not ($attributes -band [IO.FileAttributes]::Directory)) {
            throw 'Invalid save directory'
        }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
}
function Assert-PrivateStage {
    Assert-RealDirectory $stage
    $existingAcl = [IO.Directory]::GetAccessControl($stage)
    $rules = $existingAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if (-not $existingAcl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $user) {
        throw 'Save staging permissions changed'
    }
}

$ownsStage = $false
$ownsTemporary = $false
$committed = $false
try {
    Assert-RealDirectory $parent
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Save staging name already exists' }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    Assert-PrivateStage
    $ownsStage = $true
    $stream = [IO.FileStream]::new($temporary, 'CreateNew', 'Write', 'None')
    $ownsTemporary = $true
    try {
        $bytes = [Convert]::FromBase64String($record.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }

    $delays = @(25, 50, 100, 200, 400)
    for ($attempt = 0; ; $attempt++) {
        Assert-PrivateStage
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch [IO.FileNotFoundException] {}
        if ($null -ne $attributes -and ($attributes -band ($reparsePoint -bor [IO.FileAttributes]::Directory))) {
            throw 'Invalid save destination'
        }
        try {
            if ($null -eq $attributes) { [IO.File]::Move($temporary, $target) }
            else { [IO.File]::Replace($temporary, $target, $backup, $false) }
            $committed = $true
            $ownsTemporary = $false
            break
        } catch {
            $code = $_.Exception.GetBaseException().HResult -band 65535
            # ReplaceFileW can fail after moving the old file. Restore it
            # without overwriting a file created by a concurrent writer.
            if ([IO.File]::Exists($backup)) {
                Assert-PrivateStage
                if (-not ([IO.File]::Exists($target) -or [IO.Directory]::Exists($target))) {
                    [IO.File]::Move($backup, $target)
                }
                throw
            }
            if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33, 80, 183)) { throw }
            Start-Sleep -Milliseconds $delays[$attempt]
        }
    }
} finally {
    if ($ownsStage) {
        try {
            Assert-PrivateStage
            if ($ownsTemporary) { [IO.File]::Delete($temporary) }
            if ($committed) { [IO.File]::Delete($backup) }
            if (-not [IO.File]::Exists($backup)) { [IO.Directory]::Delete($stage) }
        } catch {
            # Keep a private backup if restoring it fails. A cleanup error
            # after successful replacement must not report the save as failed.
        }
    }
}
`;

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (!/^[a-z]:[\\/]/i.test(systemRoot ?? '')) throw new Error('Windows SystemRoot is unavailable');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsPowerShellEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  return { ...env, ...extra, PSModulePath: path.join(path.dirname(windowsPowerShell()), 'Modules') };
}

function windowsWriteProject(target, contents) {
  const command = Buffer.from(saveScript, 'utf16le').toString('base64');
  // ASCII wire encoding preserves Unicode file paths and UTF-8 project bytes.
  // Only the fixed command is executed. User-selected paths are JSON data.
  const payload = JSON.stringify({ target, contents: Buffer.from(contents, 'utf8').toString('base64') })
    .replace(/[^\x00-\x7f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const permissionError = () => new Error('실험 파일을 저장할 수 없습니다. 폴더와 파일의 권한을 확인해 주세요.');
  return new Promise((resolve, reject) => {
    const executable = windowsPowerShell();
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      cwd: path.dirname(executable), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env: windowsPowerShellEnv(),
    });
    child.once('error', () => reject(permissionError()));
    child.stdin.on('error', () => reject(permissionError()));
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(permissionError());
    });
    child.stdin.end(payload);
  });
}

module.exports = { windowsPowerShell, windowsPowerShellEnv, windowsWriteProject };
