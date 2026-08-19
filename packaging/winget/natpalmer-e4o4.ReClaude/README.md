# winget manifest

ReClaude installs through npm, so the winget package is a thin wrapper. Submit
these manifests to microsoft/winget-pkgs once a tagged release exists; the
version, InstallerUrl and InstallerSha256 must match that release.

Until then the supported Windows install is:

    irm https://raw.githubusercontent.com/natpalmer-e4o4/ReClaude/main/install/install.ps1 | iex

or `npm i -g @natpalmer-e4o4/reclaude`.
