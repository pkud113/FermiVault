# Install FermiVault

Download the latest version from [FermiVault Releases](https://github.com/pkud113/FermiVault/releases/latest). After installing, open FermiVault and choose any folder for your Markdown notes.

## Windows 10 and 11

1. Download `FermiVault_x.y.z_x64-setup.exe` from the latest release.
2. Open the installer and follow its steps. It installs for your Windows user without requiring administrator rights.
3. Open FermiVault from the Start menu.

An MSI installer is also available for managed deployments. To upgrade, run the new installer; your vaults and settings are retained.

The current Windows installers and their packaged app executables are digitally signed through Microsoft Azure Artifact Signing. The verified publisher is **Pardhu Kudumula**. You can inspect the downloaded installer's signature under **Properties → Digital Signatures**.

### Windows installation prompts

Microsoft SmartScreen can ask for confirmation when an app is new and has little download history, even with a valid publisher signature. Publisher verification and download reputation are separate checks; Microsoft does not guarantee a date or download count at which these prompts stop. See [Microsoft's explanation of SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Windows may show the certificate's country, state, city, and both name fields in the publisher line. These identify the same verified publisher, **Pardhu Kudumula**. Azure's Public Trust certificate uses those verified identity fields; the app cannot customize that Windows display.

If Windows reports **Unknown publisher**, check that you have the latest installer from the release page. Older unsigned downloads, including v0.1.0, retain their original signatures when a newer release is published. If the latest download's signature is missing or invalid, stop and report the filename and version through the [issue tracker](https://github.com/pkud113/FermiVault/issues).

## macOS 11 and later

Download `FermiVault_x.y.z_universal.dmg`, open it, and drag FermiVault to Applications. The universal app supports both Apple silicon and Intel Macs.

The current macOS build is not notarized. If macOS asks for confirmation on first open, review [Apple's instructions for opening apps from outside the App Store](https://support.apple.com/en-us/102445). Windows signing does not notarize the macOS app.

## Linux x64

Choose the package for your distribution:

- **AppImage:** make the downloaded file executable with `chmod +x FermiVault_x.y.z_amd64.AppImage`, then open it.
- **Debian or Ubuntu:** install the `.deb` with `sudo apt install ./FermiVault_x.y.z_amd64.deb`.
- **RPM distributions:** install the `.rpm` using your distribution's package manager.

Git sync uses Git installed on your computer. Install Git from [git-scm.com](https://git-scm.com) if it is not already available, then reopen FermiVault.
