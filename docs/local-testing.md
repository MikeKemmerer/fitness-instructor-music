# Phone Testing From Windows and WSL

Vite development and preview bind to `0.0.0.0`, not just loopback. A WSL NAT address is not the Windows Ethernet/Wi-Fi address. Windows localhost forwarding alone does not expose a WSL server to other LAN devices.

## Trusted HTTPS

The app requires a secure context for cryptographic IDs, integrity checks and offline service workers. Desktop `localhost` is an exception; `http://<LAN address>` is not. An HTTP page now shows an HTTPS-required message rather than crashing. Browser certificate warnings alone are not a reliable way to establish a trusted secure context on a phone.

Use a development certificate covering the Windows LAN hostname/IP you will open, issued by a CA trusted by the phone (for example, a deliberately installed local development CA). Never share the CA private key. Keep the server certificate/key under ignored `local-media/certificates/`. This project does not install a CA or change trust settings automatically.

From the project directory in WSL, after the certificate is available:

```sh
export REHEARSAL_HTTPS_CERT="$PWD/local-media/certificates/lan.pem"
export REHEARSAL_HTTPS_KEY="$PWD/local-media/certificates/lan-key.pem"
npm run build
npm --prefix frontend run preview -- --port 5208 --strictPort
```

Both variables are required together. They configure development/preview only, not an Azure deployment. Omit both for ordinary desktop localhost HTTP tests. Changing the origin (scheme, address or port) creates a separate browser store; import or prepare the two test songs on the phone rather than expecting the desktop library to appear there.

## WSL NAT Forwarding

Inspect the active physical interface on Windows and the WSL address first. If a forwarding rule already exists for your port, review it rather than blindly replacing it. WSL addresses can change after restart. No router port forwarding or public tunnel is needed.

An administrator must run the following in Windows PowerShell, substituting the current addresses and active Ethernet/Wi-Fi interface. Limit exposure to the trusted Private network and local subnet:

```powershell
$WindowsLanAddress = '<Windows LAN IPv4>'
$WslAddress = '<current WSL IPv4>'
$Interface = '<Ethernet or Wi-Fi interface name>'
$Port = 5208
netsh interface portproxy add v4tov4 listenaddress=$WindowsLanAddress listenport=$Port connectaddress=$WslAddress connectport=$Port protocol=tcp
New-NetFirewallRule -Name 'FitnessPreview5208' -DisplayName 'Fitness preview LAN 5208' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $WindowsLanAddress -RemoteAddress LocalSubnet -Profile Private -InterfaceAlias $Interface
```

Open `https://<Windows LAN IPv4>:5208/` on the phone after trusting the matching certificate. Do not use the WSL address or `127.0.0.1` on the phone. Guest Wi-Fi/client isolation can still block peers. A firewall permission error requires the owner/administrator; the agent must not bypass it.

Remove only the rules you added when finished (Administrator PowerShell):

```powershell
netsh interface portproxy delete v4tov4 listenaddress=$WindowsLanAddress listenport=$Port
Remove-NetFirewallRule -Name 'FitnessPreview5208'
```

## Acceptance

This is a local rehearsal app without cloud authentication; expose it only to the trusted household network. The static server must not expose `local-media/`, certificates or private songs. Use the explicit file picker. Test two songs, preview/cue controls, recorded filler, pause/resume and Bluetooth, then prepare, close/reopen the installed app and test airplane-mode playback. No desktop test establishes phone reliability. Access via a later authenticated Azure HTTPS pilot is an alternative after its deployment gate is approved.