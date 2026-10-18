# Windows release signing

The Windows Release job uses Azure Artifact Signing with a Public Trust
certificate profile. Tauri signs the application before building the installers,
then signs the NSIS `.exe` and WiX `.msi` installers. Every signing call must
produce a valid, timestamped Authenticode signature before the build proceeds.
Local development and the performance-budget builds do not use Azure signing.

## Azure setup

1. Create an Artifact Signing account on the Basic plan and complete Microsoft's
   identity validation. Individual developers must be in the US or Canada, and
   the Azure billing account must have account type Individual. Its legal name
   and address must match the ID used for verification.
   The person completing verification needs the **Artifact Signing Identity
   Verifier** role on this signing account, even if they already own the Azure
   subscription. In Identity validations, switch the client type to
   **Individuals** for a personal publisher, review and accept Microsoft's
   signing terms, and complete the identity check directly with Microsoft.
2. After identity validation succeeds, create a **Public Trust** certificate
   profile. A Private Trust or Public Trust Test profile is not suitable for
   public GitHub downloads.
3. Register a single-tenant Microsoft Entra application for FermiVault's release
   workflow. Add a GitHub federated credential with:

   | Field | Value |
   |---|---|
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Subject | `repo:pkud113@181017732/FermiVault@1419909799:environment:windows-signing` |
   | Audience | `api://AzureADTokenExchange` |

   FermiVault uses GitHub's immutable subject format. In the portal's GitHub
   scenario, use owner `pkud113`, owner ID `181017732`, repository `FermiVault`,
   repository ID `1419909799`, and entity type **Environment** with value
   `windows-signing`. Verify the current prefix with
   `gh api repos/pkud113/FermiVault/actions/oidc/customization/sub` if the
   repository's OIDC configuration changes.

4. Grant that application's service principal the **Artifact Signing Certificate
   Profile Signer** role on FermiVault's Artifact Signing account. Do not grant
   subscription Owner, Contributor, identity-validation, or profile-management
   permissions to the release application. No client secret is needed.

Microsoft's [account setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
and [OIDC integration](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md)
describe the identity validation and federation steps.

## GitHub setup

Create a repository environment named `windows-signing`. Under **Deployment
branches and tags**, choose **Selected branches and tags** and add a **Tag** rule
for `v*` and a **Branch** rule for `main`, which runs manual rebuilds. Do not allow
arbitrary branches to use this environment. Limit who can push release tags or
change `main`; a release workflow can request the signing identity.

Set these environment **variables** (Settings → Environments → windows-signing):

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID` | Application (client) ID of the release application |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SIGNING_ENDPOINT` | Account endpoint, for example `https://eus.codesigning.azure.net` for East US |
| `AZURE_SIGNING_ACCOUNT` | Artifact Signing account name |
| `AZURE_SIGNING_CERTIFICATE_PROFILE` | Public Trust certificate profile name |

For the configured FermiVault deployment, the account is `fermivault-signing`,
the endpoint is `https://eus.codesigning.azure.net`, and the Public Trust profile
name is `fermivault-release`, bound to the verified individual identity
**Pardhu Kudumula**. A new profile requires completed publisher identity
validation.

Public Trust certificate subjects contain the verified common name,
organization, city, state, and country. Windows may display all of these fields
in its publisher line, including the individual's name twice. This display is
controlled by Windows and the issued certificate. Azure's `IncludeCity`,
`IncludeState`, and `IncludeCountry` switches apply only to Private Trust
profiles, so they cannot make a Public Trust publisher line name-only. Keep
street address and postal code excluded from the public profile. See
[Microsoft's certificate profile parameters](https://learn.microsoft.com/en-us/powershell/module/az.artifactsigning/new-azartifactsigningcertificateprofile).

These are resource identifiers, not passwords. Authentication uses a short-lived
GitHub OIDC token exchanged for Azure access. Private signing keys stay in Azure.
Azure login permits an identity without subscription-management access; the
release application only needs the certificate-profile signing role.

## Release and verification

Push a version tag as described in CONTRIBUTING.md. The Release workflow builds
Windows installers into the draft release, using a temporary Tauri config for
signing. It fails if configuration, authentication, signing, timestamping, or
signature verification fails; it does not fall back to unsigned installers.

To rebuild an already published version, run **Actions → Release → Run workflow**
on `main` and enter its existing tag, such as `v0.2.0`. This builds only Windows,
checks out that tag's application source, and uses the signing hook from the
workflow revision. It saves the signed installers as a workflow artifact named
`signed-windows-v0.2.0` for verification. A manual rebuild does not publish or
replace GitHub release assets. Once verified, the maintainers can upload those
installers to the corresponding release.

Before publishing the draft, download its Windows installers and inspect each:

```powershell
Get-AuthenticodeSignature -LiteralPath .\FermiVault_x.y.z_x64-setup.exe |
    Format-List Status, SignerCertificate, TimeStamperCertificate
Get-AuthenticodeSignature -LiteralPath .\FermiVault_x.y.z_x64_en-US.msi |
    Format-List Status, SignerCertificate, TimeStamperCertificate
```

Confirm `Status` is `Valid`, the publisher is the verified identity, and there is
a timestamp. Test installation on a clean Windows machine. A new signed release
can still receive a SmartScreen reputation warning; verified publisher identity
does not guarantee immediate SmartScreen reputation.
