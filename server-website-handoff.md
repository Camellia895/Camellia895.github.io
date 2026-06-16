# Server Website Handoff

## Current Setup

- Server alias on the user's own PowerShell: `my-server`
- Server IP: `47.109.109.117`
- Server OS: Ubuntu 24.04
- Server panel: BaoTa / BT panel
- SSH user currently used: `root`
- Main website directory on server: `/www/wwwroot/me.camellia895.top`
- Other observed directories:
  - `/www/wwwroot/test.camellia895.top`
  - `/www/wwwroot/panel_ssl_site`

## SSH Access For Codex

Codex was given a dedicated sandbox SSH key in the workspace:

- Private key path: `work/codex_sandbox_my_server_ed25519`
- Public key path: `work/codex_sandbox_my_server_ed25519.pub`
- Public key comment: `codex-sandbox-my-server`

The public key was added to:

```text
/root/.ssh/authorized_keys
```

Codex successfully connected with:

```powershell
ssh -i .\work\codex_sandbox_my_server_ed25519 -o IdentitiesOnly=yes root@47.109.109.117
```

Do not expose or paste private key contents.

## Website Publishing Flow

The website is not primarily edited on the server.

Expected flow:

```text
G:\网页设计
  -> GitHub repository main branch
  -> GitHub Actions build
  -> gh-pages branch
  -> server pulls gh-pages
  -> /www/wwwroot/me.camellia895.top
```

Repository:

```text
Camellia895/Camellia895.github.io
```

Source branch:

```text
main
```

Published branch pulled by server:

```text
gh-pages
```

## Important Working Rule

Avoid directly editing files under:

```text
/www/wwwroot/me.camellia895.top
```

Those files are built output from `gh-pages` and may be overwritten by the next server pull.

For content or design changes, edit the source files in:

```text
G:\网页设计
```

Then push to GitHub `main`, wait for GitHub Actions, and let the server pull from `gh-pages`.

## Auto Pull

The server reportedly has an automatic pull script that runs about every 6 hours.

Not yet verified:

- Whether it is configured in BaoTa scheduled tasks
- Whether it is configured in system cron
- Exact command it runs
- Log location

Good next read-only checks:

```bash
crontab -l
ls -la /etc/cron.d
grep -R "me.camellia895.top\|gh-pages\|git pull" /etc/cron* /www/server/cron 2>/dev/null
```

For immediate deployment, a likely manual command is:

```bash
cd /www/wwwroot/me.camellia895.top
git status
git pull
```

Run `git status` before `git pull`.

## Safety Notes

- Password SSH login is disabled on the server.
- `PermitRootLogin yes` was observed.
- `PasswordAuthentication no` was observed.
- Long term, it would be safer to create a non-root deploy user for website management.
- Before modifying server files, first inspect status and consider making a backup.

