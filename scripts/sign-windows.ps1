# Tauri calls this for the application executable and each Windows installer,
# before it packages or uploads them. Authentication comes from azure/login's
# short-lived GitHub OIDC session; there is no client secret or exported key.
param(
    [Parameter(Mandatory, Position = 0)]
    [string] $Path
)

$ErrorActionPreference = 'Stop'

foreach ($name in @('AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_CERTIFICATE_PROFILE')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
        throw "Missing $name. Refusing to publish an unsigned Windows release."
    }
}

$endpoint = [Uri] $env:AZURE_SIGNING_ENDPOINT
if ($endpoint.Scheme -ne 'https' -or $endpoint.Host -notmatch '^[a-z0-9-]+\.codesigning\.azure\.net$') {
    throw 'AZURE_SIGNING_ENDPOINT must be an HTTPS Azure Artifact Signing endpoint.'
}

$file = Get-Item -LiteralPath $Path
if ($file.PSIsContainer -or $file.Extension -notin @('.exe', '.dll', '.msi')) {
    throw "Unexpected Windows signing target: $Path"
}

Import-Module ArtifactSigning -RequiredVersion 0.1.20 -ErrorAction Stop

$signing = @{
    Endpoint = $endpoint.AbsoluteUri
    CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT
    CertificateProfileName = $env:AZURE_SIGNING_CERTIFICATE_PROFILE
    Files = $file.FullName
    FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
    TimestampDigest = 'SHA256'
    Description = 'FermiVault'
    DescriptionUrl = 'https://github.com/pkud113/FermiVault'
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}
Invoke-ArtifactSigning @signing

$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
    throw "A valid, timestamped Authenticode signature is required for $($file.Name): $($signature.Status)"
}
Write-Output "Signed and verified $($file.Name): $($signature.SignerCertificate.Subject)"
