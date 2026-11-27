param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][ValidatePattern('\A[A-Fa-f0-9]{40}\z')][string]$ExpectedThumbprint
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Windows executable not found.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode') {
  throw "Expected a valid embedded Authenticode signature. Status $($signature.Status)."
}
if ($signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
  throw 'The signer certificate does not match the expected publisher thumbprint.'
}
if (-not $signature.TimeStamperCertificate) { throw 'The Authenticode signature must be timestamped.' }
Write-Output "Verified publisher and Authenticode timestamp for $([IO.Path]::GetFileName($Path))."
