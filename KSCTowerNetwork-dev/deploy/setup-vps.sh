#!/usr/bin/env bash
# =============================================================================
# KSCTowerNetwork — fresh-Ubuntu-server bootstrap
#
# Takes a brand-new Ubuntu Server 22.04 / 24.04 LTS box from "just provisioned"
# to "hardened, TLS-terminated, KSCTowerNetwork backend + web are running and
# survive reboot".
#
# WHAT IT DOES
#   1.  apt update/upgrade + unattended-upgrades (auto-patch security CVEs)
#   2.  Create non-root sudo user, install your SSH public key
#   3.  Lock down sshd: no root login, no password auth, key-only
#   4.  UFW firewall: deny in by default, allow only SSH/80/443
#   5.  fail2ban for brute-force protection on sshd
#   6.  Add a small swapfile (smol VPSes OOM without it during npm install)
#   7.  Node.js 24 LTS from NodeSource (aligns with bridge tooling in repo)
#   8.  nginx + certbot
#   9.  MariaDB + Redis (optional, see CONFIG)
#   10. Clone repo, npm ci + build backend + web
#   11. Write /etc/ksctower.env with random secrets baked in
#   12. systemd unit for backend, autostarts on boot
#   13. nginx site that serves web/dist and proxies /v1 → backend
#   14. certbot --nginx to get a Let's Encrypt cert + auto-renewal timer
#
# WHAT IT DOES NOT DO
#   - Install LiveKit (you use LiveKit Cloud — voice does not transit this VPS)
#   - Install the voice-bridge (runs on each pilot's PC alongside KSP)
#   - Build / ship the KSP plugin DLL (do that on Windows with build-plugin.ps1)
#
# USAGE
#   1. SSH into the fresh box as root (or a sudo user).
#   2. Edit the CONFIG block below — at minimum: DOMAIN, LETSENCRYPT_EMAIL,
#      DEPLOY_USER, SSH_PUBKEY, and the LiveKit + login user secrets.
#   3. sudo bash setup-vps.sh
#   4. Wait. The script is idempotent — safe to re-run if a step fails.
#   5. After it finishes: open a SECOND ssh session as $DEPLOY_USER with your
#      key BEFORE closing the current one, to verify you're not locked out.
#
# Tested on: Ubuntu Server 24.04 LTS (Noble), 22.04 LTS (Jammy).
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIG — edit before first run
# =============================================================================

# --- Networking ---------------------------------------------------------------
DOMAIN="tower.example.com"                # public hostname pointing at this VPS
LETSENCRYPT_EMAIL="you@example.com"       # for cert expiry notices (LE only)
SSH_PORT=22                               # leave 22 unless you really want to move it

# --- Cloudflare ---------------------------------------------------------------
# 1 = lock down origin so ONLY Cloudflare's edge can reach 80/443 (recommended).
#     Also rewrites $remote_addr from CF-Connecting-IP so logs / rate-limit /
#     IP bans see real client IPs instead of Cloudflare's edge.
# 0 = direct exposure (no Cloudflare in front). Uses Let's Encrypt via certbot.
BEHIND_CLOUDFLARE=1

# Cloudflare API token. Create one at:
#   https://dash.cloudflare.com/profile/api-tokens → "Create Token" → "Custom"
# Give it these scopes (all under "Permissions"):
#   Zone     → DNS                  → Edit
#   Zone     → Zone Settings        → Edit
#   Zone     → SSL and Certificates → Edit
#   User     → SSL and Certificates → Edit   (required to mint Origin Certs)
# Zone Resources: Include → Specific zone → <your apex zone, e.g. example.com>
#
# When this is set, the script will:
#   - generate the Origin Cert + key automatically (15-yr, no renewal)
#   - create/upsert the proxied A record for $DOMAIN
#   - set SSL/TLS = Full (strict), Always Use HTTPS, min TLS 1.2, WebSockets on
#   - enable Authenticated Origin Pulls and configure nginx to verify them
# Leave empty if you'd rather click through the CF dashboard yourself; in that
# case place the cert/key at the paths below before running.
CF_API_TOKEN=""

# Apex zone (e.g. "example.com" if DOMAIN is "tower.example.com"). Auto-derived
# from $DOMAIN if you leave this blank — only set it if your zone is multi-label
# (e.g. DOMAIN="tower.foo.co.uk", CF_ZONE_NAME="foo.co.uk").
CF_ZONE_NAME=""

# Public IPv4 of this VPS. Leave blank to autodetect via api.ipify.org.
CF_VPS_PUBLIC_IP=""

# Where the Origin Cert + key end up on disk. The script writes them; nginx
# reads them. Don't change unless you have a reason.
CF_ORIGIN_CERT_PATH="/etc/ssl/cloudflare/origin.crt"
CF_ORIGIN_KEY_PATH="/etc/ssl/cloudflare/origin.key"
CF_AOP_CA_PATH="/etc/ssl/cloudflare/authenticated_origin_pull_ca.pem"

# --- Deploy user --------------------------------------------------------------
DEPLOY_USER="tower"
# Paste the FULL one-line public key (~/.ssh/id_ed25519.pub on your laptop):
SSH_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA__REPLACE_ME__ you@laptop"

# --- Repo + paths -------------------------------------------------------------
APP_REPO_URL="https://github.com/SpaceFoon/KSCTowerNetwork.git"
APP_BRANCH="main"
APP_BASE="/opt/ksctower"                  # repo gets cloned here
BACKEND_DIR_REL="KSCTowerNetwork-dev/backend"
WEB_DIR_REL="KSCTowerNetwork-dev/web"

# --- Backend runtime ----------------------------------------------------------
BACKEND_PORT=48787

# --- Database / cache ---------------------------------------------------------
INSTALL_MARIADB=1                         # 1 = install + use, 0 = skip (in-memory)
INSTALL_REDIS=1                           # 1 = install + use, 0 = skip
DB_NAME="ksc_tower"
DB_USER="ksc_tower"
DB_PASSWORD=""                            # leave "" to auto-generate

# --- LiveKit Cloud ------------------------------------------------------------
# Get these from https://cloud.livekit.io → your project → Settings → Keys.
LIVEKIT_WS_URL="wss://ksc-tower-3rxe40fy.livekit.cloud"
LIVEKIT_API_KEY="REPLACE_ME"
LIVEKIT_API_SECRET="REPLACE_ME"

# --- Web login users ----------------------------------------------------------
# JSON array of {userId,email,role} plus either password (first-boot hash) or
# passwordHash (argon2id PHC string — preferred for production).
# role ∈ owner|controller|pilot|guest|mod|supermod.
# Plaintext passwords are hashed at first boot; backend warns until you use passwordHash.
# At MINIMUM change every password here before running the script.
WEB_LOGIN_USERS_JSON='[
  {"userId":"owner_prod","email":"you@example.com","password":"CHANGE_ME_owner","role":"owner"},
  {"userId":"buddy_prod","email":"buddy@example.com","password":"CHANGE_ME_buddy","role":"controller"}
]'
OWNER_USER_ID="owner_prod"
# Self-serve signup: invite_only recommended for public VPS until you intentionally open registration.
REGISTRATION_MODE=invite_only
REGISTRATION_DEFAULT_ROLE=pilot

# =============================================================================
# Internals — do not edit below this line unless you know why
# =============================================================================

APP_REPO_DIR="${APP_BASE}/repo"
BACKEND_DIR="${APP_REPO_DIR}/${BACKEND_DIR_REL}"
WEB_DIR="${APP_REPO_DIR}/${WEB_DIR_REL}"
ENV_FILE="/etc/ksctower.env"
SYSTEMD_UNIT="/etc/systemd/system/ksctower-backend.service"
NGINX_SITE="/etc/nginx/sites-available/ksctower"
NGINX_LINK="/etc/nginx/sites-enabled/ksctower"

C_RESET=$'\033[0m'
C_CYAN=$'\033[1;36m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'
C_GREEN=$'\033[1;32m'

log()  { printf '\n%s[setup]%s %s\n' "$C_CYAN"   "$C_RESET" "$*"; }
warn() { printf '\n%s[warn]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf '\n%s[err]%s   %s\n' "$C_RED"    "$C_RESET" "$*" >&2; }
ok()   { printf '%s   ✓%s %s\n'      "$C_GREEN"  "$C_RESET" "$*"; }

require_root() {
    if [[ $EUID -ne 0 ]]; then
        err "Must run as root. Try: sudo bash $0"
        exit 1
    fi
}

require_ubuntu() {
    if ! grep -qiE '^ID=(ubuntu|debian)$' /etc/os-release 2>/dev/null; then
        warn "This script targets Ubuntu/Debian. Continuing anyway."
    fi
}

require_config() {
    local bad=0
    [[ "$INSTALL_MARIADB" != "1" ]] && { err "Production requires MariaDB; use the server-only guide for external databases."; bad=1; }
    [[ "$INSTALL_REDIS" != "1" ]] && { err "Production requires Redis; use the server-only guide for external caches."; bad=1; }
    [[ "$DOMAIN" == "tower.example.com" ]]         && { err "Set DOMAIN";              bad=1; }
    [[ "$LETSENCRYPT_EMAIL" == "you@example.com" ]] && { err "Set LETSENCRYPT_EMAIL";  bad=1; }
    [[ "$SSH_PUBKEY" == *"__REPLACE_ME__"* ]]      && { err "Set SSH_PUBKEY";          bad=1; }
    [[ "$LIVEKIT_API_KEY" == "REPLACE_ME" ]]       && { err "Set LIVEKIT_API_KEY";     bad=1; }
    [[ "$LIVEKIT_API_SECRET" == "REPLACE_ME" ]]    && { err "Set LIVEKIT_API_SECRET";  bad=1; }
    [[ "$WEB_LOGIN_USERS_JSON" == *"CHANGE_ME"* ]] && { err "Set passwords in WEB_LOGIN_USERS_JSON"; bad=1; }
    if [[ "$BEHIND_CLOUDFLARE" == "1" ]]; then
        # Two ways to supply the Origin Cert: API token (script mints it) or
        # pre-staged files (you pasted them in before running). Need one or the other.
        if [[ -z "$CF_API_TOKEN" ]]; then
            if [[ ! -s "$CF_ORIGIN_CERT_PATH" || ! -s "$CF_ORIGIN_KEY_PATH" ]]; then
                err "BEHIND_CLOUDFLARE=1 with no CF_API_TOKEN, and no pre-staged cert files."
                err "  EITHER set CF_API_TOKEN in the CONFIG block (recommended)"
                err "  OR     place files at $CF_ORIGIN_CERT_PATH and $CF_ORIGIN_KEY_PATH"
                bad=1
            fi
        fi
    fi
    if [[ $bad -ne 0 ]]; then
        err "Refusing to run with placeholder config. Edit the CONFIG block at the top of $0."
        exit 2
    fi
}

# -----------------------------------------------------------------------------
# 1. apt update + base packages
# -----------------------------------------------------------------------------
step_apt() {
    log "Updating apt + installing base packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get -o Dpkg::Options::="--force-confold" upgrade -y
    apt-get install -y \
        ca-certificates curl gnupg lsb-release \
        git build-essential pkg-config python3 \
        ufw fail2ban unattended-upgrades \
        software-properties-common
    ok "base packages installed"
}

# -----------------------------------------------------------------------------
# 2. Auto security updates
# -----------------------------------------------------------------------------
step_unattended_upgrades() {
    log "Enabling unattended-upgrades (auto security patches)"
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
    cat >/etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
    systemctl enable --now unattended-upgrades.service
    ok "unattended-upgrades active"
}

# -----------------------------------------------------------------------------
# 3. Deploy user + SSH key
# -----------------------------------------------------------------------------
step_deploy_user() {
    log "Creating deploy user: $DEPLOY_USER"
    if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
        adduser --disabled-password --gecos "" "$DEPLOY_USER"
    fi
    usermod -aG sudo "$DEPLOY_USER"
    # Allow passwordless sudo for the deploy user (since password auth is gone).
    echo "$DEPLOY_USER ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/90-${DEPLOY_USER}
    chmod 440 /etc/sudoers.d/90-${DEPLOY_USER}

    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
    if ! grep -qF "$SSH_PUBKEY" "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null; then
        echo "$SSH_PUBKEY" >>"/home/$DEPLOY_USER/.ssh/authorized_keys"
    fi
    chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
    chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
    ok "deploy user ready, key installed"
}

# -----------------------------------------------------------------------------
# 4. SSH hardening
# -----------------------------------------------------------------------------
step_harden_ssh() {
    log "Hardening sshd (key-only, no root, port $SSH_PORT)"
    install -d -m 755 /etc/ssh/sshd_config.d
    cat >/etc/ssh/sshd_config.d/99-ksctower.conf <<EOF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
MaxAuthTries 3
LoginGraceTime 20s
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers ${DEPLOY_USER}
EOF
    sshd -t
    systemctl reload ssh || systemctl reload sshd
    ok "sshd hardened"
    warn "Open a SECOND terminal NOW and confirm:  ssh -p $SSH_PORT $DEPLOY_USER@$DOMAIN"
    warn "Do not close this session until that succeeds."
}

# -----------------------------------------------------------------------------
# 5. Firewall
# -----------------------------------------------------------------------------
step_firewall() {
    log "Configuring UFW"
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow "${SSH_PORT}/tcp" comment "ssh"

    if [[ "$BEHIND_CLOUDFLARE" == "1" ]]; then
        log "Restricting 80/443 to Cloudflare edge IPs only (anti-bypass)"
        # Fetch the canonical CF ranges. If this VPS can't reach cloudflare.com
        # at provisioning time, abort — opening 80/443 to the world by accident
        # would defeat the entire point of being behind Cloudflare.
        local v4 v6
        v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
        v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
        if [[ -z "$v4" || -z "$v6" ]]; then
            err "Failed to fetch Cloudflare IP ranges. Aborting before opening 80/443."
            exit 4
        fi
        # Stash the lists for the nginx real-ip include and the weekly refresh timer.
        install -d -m 755 /etc/cloudflare
        printf '%s\n' "$v4" >/etc/cloudflare/ips-v4
        printf '%s\n' "$v6" >/etc/cloudflare/ips-v6
        while IFS= read -r cidr; do
            [[ -z "$cidr" ]] && continue
            ufw allow from "$cidr" to any port 80  proto tcp comment "cloudflare http"
            ufw allow from "$cidr" to any port 443 proto tcp comment "cloudflare https"
        done < <(printf '%s\n%s\n' "$v4" "$v6")
        # Install the weekly refresh job (defined further down in step_cloudflare_refresh).
    else
        ufw allow 80/tcp  comment "http (acme + redirect)"
        ufw allow 443/tcp comment "https"
    fi

    ufw --force enable
    ok "ufw active: $(ufw status | grep -c ALLOW) allow rules"
}

# -----------------------------------------------------------------------------
# 5b. Weekly refresh of Cloudflare IP ranges (CF rotates them rarely but does)
# -----------------------------------------------------------------------------
step_cloudflare_refresh() {
    [[ "$BEHIND_CLOUDFLARE" == "1" ]] || { ok "CF refresh skipped"; return; }
    log "Installing weekly Cloudflare IP-list refresh timer"
    cat >/usr/local/sbin/refresh-cloudflare-ips.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
v4="$(curl -fsS https://www.cloudflare.com/ips-v4)"
v6="$(curl -fsS https://www.cloudflare.com/ips-v6)"
[[ -z "$v4" || -z "$v6" ]] && { echo "fetch failed" >&2; exit 1; }
old_v4="$(cat /etc/cloudflare/ips-v4 2>/dev/null || true)"
old_v6="$(cat /etc/cloudflare/ips-v6 2>/dev/null || true)"
if [[ "$v4" == "$old_v4" && "$v6" == "$old_v6" ]]; then
    exit 0
fi
printf '%s\n' "$v4" >/etc/cloudflare/ips-v4
printf '%s\n' "$v6" >/etc/cloudflare/ips-v6

# Rebuild nginx real_ip include.
{
    echo "# AUTO-GENERATED by refresh-cloudflare-ips.sh — do not edit"
    while IFS= read -r cidr; do [[ -n "$cidr" ]] && echo "set_real_ip_from $cidr;"; done < /etc/cloudflare/ips-v4
    while IFS= read -r cidr; do [[ -n "$cidr" ]] && echo "set_real_ip_from $cidr;"; done < /etc/cloudflare/ips-v6
    echo "real_ip_header CF-Connecting-IP;"
    echo "real_ip_recursive on;"
} >/etc/nginx/conf.d/cloudflare-realip.conf
nginx -t && systemctl reload nginx

# Reconcile UFW rules.
mapfile -t want < <(cat /etc/cloudflare/ips-v4 /etc/cloudflare/ips-v6 | awk 'NF')
# Drop any existing CF rules, then re-add the canonical set.
ufw status numbered | awk '/cloudflare http(s)?/{print $1}' | tr -d '[]' | sort -rn | \
    xargs -r -I{} bash -c 'yes | ufw delete {}' >/dev/null
for cidr in "${want[@]}"; do
    ufw allow from "$cidr" to any port 80  proto tcp comment "cloudflare http"
    ufw allow from "$cidr" to any port 443 proto tcp comment "cloudflare https"
done
EOF
    chmod 750 /usr/local/sbin/refresh-cloudflare-ips.sh

    cat >/etc/systemd/system/refresh-cloudflare-ips.service <<EOF
[Unit]
Description=Refresh Cloudflare IP allowlist (UFW + nginx real_ip)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/refresh-cloudflare-ips.sh
EOF
    cat >/etc/systemd/system/refresh-cloudflare-ips.timer <<'EOF'
[Unit]
Description=Weekly Cloudflare IP-list refresh

[Timer]
OnCalendar=weekly
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now refresh-cloudflare-ips.timer
    ok "weekly CF refresh timer armed"
}

# -----------------------------------------------------------------------------
# 5c. Cloudflare API: DNS, SSL settings, Origin Cert, Authenticated Origin Pulls
# -----------------------------------------------------------------------------
step_cloudflare_api() {
    [[ "$BEHIND_CLOUDFLARE" == "1" ]] || { ok "CF API skipped (not behind CF)"; return; }
    install -d -m 755 /etc/ssl/cloudflare

    # --- Manual mode: cert files were staged before running. Just fetch the
    # Authenticated-Origin-Pulls CA cert (public, no auth) and we're done.
    if [[ -z "$CF_API_TOKEN" ]]; then
        log "CF_API_TOKEN not set — using pre-staged cert files. Fetching AOP CA only."
        curl -fsSL -o "$CF_AOP_CA_PATH" \
            https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem || \
            warn "Failed to fetch AOP CA cert; nginx will be configured without ssl_verify_client."
        chmod 644 "$CF_AOP_CA_PATH" 2>/dev/null || true
        return
    fi

    apt-get install -y jq >/dev/null
    local api="https://api.cloudflare.com/client/v4"
    local hdr_auth="Authorization: Bearer ${CF_API_TOKEN}"
    local hdr_json="Content-Type: application/json"

    cf_api() {
        # cf_api METHOD PATH [JSON_BODY]
        local method="$1" path="$2" body="${3:-}"
        if [[ -n "$body" ]]; then
            curl -fsS -X "$method" -H "$hdr_auth" -H "$hdr_json" -d "$body" "${api}${path}"
        else
            curl -fsS -X "$method" -H "$hdr_auth" "${api}${path}"
        fi
    }

    # --- 1. Verify token works.
    log "Verifying Cloudflare API token"
    if ! cf_api GET /user/tokens/verify | jq -e '.result.status == "active"' >/dev/null; then
        err "CF API token verification failed. Check the token's permissions:"
        err "  Zone:DNS:Edit, Zone:Zone Settings:Edit, Zone:SSL:Edit, User:SSL:Edit"
        exit 5
    fi
    ok "CF token active"

    # --- 2. Resolve apex zone name from DOMAIN if not set.
    local zone_name="$CF_ZONE_NAME"
    if [[ -z "$zone_name" ]]; then
        # naive split: "tower.example.com" → "example.com"; correct for single-TLD zones.
        # For multi-label zones (foo.co.uk) the user must set CF_ZONE_NAME explicitly.
        zone_name="$(echo "$DOMAIN" | awk -F. '{n=NF; print $(n-1)"."$n}')"
    fi
    log "Looking up zone: $zone_name"
    local zone_id
    zone_id="$(cf_api GET "/zones?name=${zone_name}" | jq -r '.result[0].id // empty')"
    if [[ -z "$zone_id" ]]; then
        err "Cloudflare zone '$zone_name' not found / not visible to this token."
        err "If your zone is multi-label (e.g. foo.co.uk), set CF_ZONE_NAME explicitly."
        exit 5
    fi
    ok "zone $zone_name → $zone_id"

    # --- 3. Detect public IP if not provided.
    if [[ -z "$CF_VPS_PUBLIC_IP" ]]; then
        CF_VPS_PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
    fi
    if [[ -z "$CF_VPS_PUBLIC_IP" ]]; then
        err "Could not determine VPS public IP; set CF_VPS_PUBLIC_IP in CONFIG."
        exit 5
    fi
    ok "VPS public IP: $CF_VPS_PUBLIC_IP"

    # --- 4. Upsert proxied A record for $DOMAIN.
    log "Upserting DNS A record: $DOMAIN → $CF_VPS_PUBLIC_IP (proxied)"
    local rec_id
    rec_id="$(cf_api GET "/zones/${zone_id}/dns_records?type=A&name=${DOMAIN}" | jq -r '.result[0].id // empty')"
    local rec_body
    rec_body="$(jq -nc \
        --arg name "$DOMAIN" \
        --arg content "$CF_VPS_PUBLIC_IP" \
        '{type:"A", name:$name, content:$content, ttl:1, proxied:true}')"
    if [[ -n "$rec_id" ]]; then
        cf_api PUT "/zones/${zone_id}/dns_records/${rec_id}" "$rec_body" >/dev/null
    else
        cf_api POST "/zones/${zone_id}/dns_records" "$rec_body" >/dev/null
    fi
    ok "DNS A record live (orange cloud)"

    # --- 5. Apply zone settings. PATCH each one; warn but don't abort on individual
    # failures (Bot Fight Mode endpoint varies by plan tier).
    apply_setting() {
        local key="$1" val_json="$2" label="$3"
        if cf_api PATCH "/zones/${zone_id}/settings/${key}" "{\"value\":${val_json}}" \
            | jq -e '.success == true' >/dev/null 2>&1; then
            ok "set $label = $val_json"
        else
            warn "could not set $label (plan / endpoint may not support it; check dashboard)"
        fi
    }
    log "Applying zone hardening settings"
    apply_setting ssl                  '"strict"'  "SSL/TLS mode (Full strict)"
    apply_setting always_use_https     '"on"'      "Always Use HTTPS"
    apply_setting min_tls_version      '"1.2"'     "Min TLS Version"
    apply_setting tls_1_3              '"on"'      "TLS 1.3"
    apply_setting websockets           '"on"'      "WebSockets"
    apply_setting tls_client_auth      '"on"'      "Authenticated Origin Pulls (zone-level)"
    apply_setting opportunistic_encryption '"on"'  "Opportunistic Encryption"
    apply_setting automatic_https_rewrites '"on"'  "Automatic HTTPS Rewrites"
    apply_setting browser_check        '"on"'      "Browser Integrity Check"
    apply_setting security_level       '"medium"'  "Security Level"
    # Bot Fight Mode lives at a different path; best-effort.
    if cf_api PUT "/zones/${zone_id}/bot_management" '{"fight_mode":true}' \
        | jq -e '.success == true' >/dev/null 2>&1; then
        ok "Bot Fight Mode enabled"
    else
        warn "Could not enable Bot Fight Mode via API; toggle it in the dashboard (Security → Bots)."
    fi

    # --- 6. Mint Origin Certificate (if not already on disk).
    if [[ -s "$CF_ORIGIN_CERT_PATH" && -s "$CF_ORIGIN_KEY_PATH" ]]; then
        ok "Origin cert + key already present, leaving untouched"
    else
        log "Generating private key + CSR for Origin Certificate"
        umask 077
        openssl genrsa -out "$CF_ORIGIN_KEY_PATH" 2048 >/dev/null 2>&1
        local csr_path="/tmp/origin-${DOMAIN}.csr"
        openssl req -new -key "$CF_ORIGIN_KEY_PATH" -out "$csr_path" \
            -subj "/CN=${DOMAIN}/O=KSCTowerNetwork" >/dev/null 2>&1
        umask 022

        log "Requesting Origin Certificate from Cloudflare (15-yr validity)"
        local csr_pem cert_body cert_resp cert_pem
        csr_pem="$(cat "$csr_path")"
        cert_body="$(jq -nc \
            --arg csr "$csr_pem" \
            --arg host "$DOMAIN" \
            '{hostnames:[$host], requested_validity:5475, request_type:"origin-rsa", csr:$csr}')"
        cert_resp="$(curl -fsS -X POST -H "$hdr_auth" -H "$hdr_json" \
            -d "$cert_body" "${api}/certificates")"
        if ! echo "$cert_resp" | jq -e '.success == true' >/dev/null; then
            err "Origin Cert API call failed:"
            echo "$cert_resp" | jq . >&2 || echo "$cert_resp" >&2
            err "Token needs User:SSL and Certificates:Edit scope."
            exit 5
        fi
        cert_pem="$(echo "$cert_resp" | jq -r '.result.certificate')"
        printf '%s\n' "$cert_pem" >"$CF_ORIGIN_CERT_PATH"
        chmod 644 "$CF_ORIGIN_CERT_PATH"
        chmod 600 "$CF_ORIGIN_KEY_PATH"
        rm -f "$csr_path"
        ok "Origin Certificate written to $CF_ORIGIN_CERT_PATH (15-yr, no renewal needed)"
    fi

    # --- 7. AOP CA cert (public, no auth needed).
    log "Fetching Authenticated Origin Pulls CA"
    if curl -fsSL -o "$CF_AOP_CA_PATH" \
        https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem; then
        chmod 644 "$CF_AOP_CA_PATH"
        ok "AOP CA at $CF_AOP_CA_PATH"
    else
        warn "Failed to fetch AOP CA; nginx will skip ssl_verify_client."
        rm -f "$CF_AOP_CA_PATH"
    fi
}

# -----------------------------------------------------------------------------
# 6. fail2ban
# -----------------------------------------------------------------------------
step_fail2ban() {
    log "Configuring fail2ban for sshd"
    cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled  = true
port     = ${SSH_PORT}
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
    systemctl enable --now fail2ban
    ok "fail2ban running"
}

# -----------------------------------------------------------------------------
# 7. Swap (helps on 1 GB VPSes during npm install / vite build)
# -----------------------------------------------------------------------------
step_swap() {
    if [[ -f /swapfile ]]; then ok "swapfile already exists"; return; fi
    log "Creating 2 GB swapfile"
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    ok "2 GB swap online"
}

# -----------------------------------------------------------------------------
# 8. Node.js 24 LTS via NodeSource
# -----------------------------------------------------------------------------
step_node() {
    if command -v node >/dev/null 2>&1 && node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number);process.exit(major===24&&(minor>22||(minor===22&&patch>=1))?0:1)'; then
        ok "node $(node --version) already installed"
        return
    fi
    if command -v node >/dev/null 2>&1; then
        warn "Node $(node --version) is older than v24.22.1 or outside Node 24 — upgrading via NodeSource"
    fi
    log "Installing Node.js 24 LTS"
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs
    ok "node $(node --version), npm $(npm --version)"
}

# -----------------------------------------------------------------------------
# 9. nginx + certbot
# -----------------------------------------------------------------------------
step_nginx() {
    log "Installing nginx + certbot"
    apt-get install -y nginx certbot python3-certbot-nginx
    systemctl enable --now nginx
    ok "nginx + certbot installed"
}

# -----------------------------------------------------------------------------
# 10. MariaDB
# -----------------------------------------------------------------------------
step_mariadb() {
    [[ "$INSTALL_MARIADB" == "1" ]] || { ok "MariaDB skipped (in-memory mode)"; return; }
    log "Installing MariaDB"
    apt-get install -y mariadb-server
    systemctl enable --now mariadb
    if [[ -z "$DB_PASSWORD" ]]; then DB_PASSWORD="$(openssl rand -hex 24)"; fi
    mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
    ok "MariaDB ready (db=$DB_NAME user=$DB_USER)"
}

# -----------------------------------------------------------------------------
# 11. Redis
# -----------------------------------------------------------------------------
step_redis() {
    [[ "$INSTALL_REDIS" == "1" ]] || { ok "Redis skipped (in-memory mode)"; return; }
    log "Installing Redis"
    apt-get install -y redis-server
    sed -i 's/^# *bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf || true
    sed -i 's/^supervised .*/supervised systemd/' /etc/redis/redis.conf || true
    systemctl enable --now redis-server
    ok "Redis on 127.0.0.1:6379"
}

# -----------------------------------------------------------------------------
# 12. Clone repo
# -----------------------------------------------------------------------------
step_clone() {
    log "Cloning $APP_REPO_URL → $APP_REPO_DIR"
    install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_BASE"
    if [[ -d "$APP_REPO_DIR/.git" ]]; then
        sudo -u "$DEPLOY_USER" git -C "$APP_REPO_DIR" fetch --all --prune
        sudo -u "$DEPLOY_USER" git -C "$APP_REPO_DIR" reset --hard "origin/${APP_BRANCH}"
    else
        sudo -u "$DEPLOY_USER" git clone --branch "$APP_BRANCH" --depth 1 "$APP_REPO_URL" "$APP_REPO_DIR"
    fi
    ok "repo at $(sudo -u "$DEPLOY_USER" git -C "$APP_REPO_DIR" rev-parse --short HEAD)"
}

# -----------------------------------------------------------------------------
# 13. Build backend + web
# -----------------------------------------------------------------------------
step_build() {
    log "npm ci + build (backend)"
    sudo -u "$DEPLOY_USER" -H bash -lc "cd '$BACKEND_DIR' && npm ci && npm run build"
    log "npm ci + build (web)"
    # Single-origin: leave VITE_API_BASE empty so SPA uses relative /v1.
    sudo -u "$DEPLOY_USER" -H bash -lc "cd '$WEB_DIR' && VITE_API_BASE='' npm ci && npm run build"
    ok "backend dist/ + web dist/ built"
}

# -----------------------------------------------------------------------------
# 14. Production env file
# -----------------------------------------------------------------------------
step_env_file() {
    log "Writing $ENV_FILE"
    local jwt; jwt="$(openssl rand -hex 32)"
    local db_block redis_block
    if [[ "$INSTALL_MARIADB" == "1" ]]; then
        db_block=$(cat <<EOF
MARIADB_HOST=127.0.0.1
MARIADB_PORT=3306
MARIADB_USER=${DB_USER}
MARIADB_PASSWORD=${DB_PASSWORD}
MARIADB_DATABASE=${DB_NAME}
EOF
)
    else
        db_block="# MariaDB intentionally omitted — backend uses in-memory store"
    fi
    if [[ "$INSTALL_REDIS" == "1" ]]; then
        redis_block="REDIS_URL=redis://127.0.0.1:6379"
    else
        redis_block="# Redis intentionally omitted"
    fi

    install -m 640 /dev/null "$ENV_FILE"
    cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=${BACKEND_PORT}

APP_JWT_SECRET=${jwt}
APP_JWT_EXPIRES_IN_SECONDS=604800

LIVEKIT_WS_URL=${LIVEKIT_WS_URL}
LIVEKIT_URL=${LIVEKIT_WS_URL}
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}

CORS_ORIGINS=https://${DOMAIN}

# Single trusted proxy: nginx (which already rewrote $remote_addr to the real
# client IP via CF-Connecting-IP when behind Cloudflare). Required so the
# backend's rate-limiter and IP-ban logic see real client IPs rather than
# attributing every request to 127.0.0.1.
TRUST_PROXY=1

WEB_LOGIN_USERS_JSON=$(printf '%s' "$WEB_LOGIN_USERS_JSON" | tr -d '\n')
OWNER_USER_ID=${OWNER_USER_ID}
REGISTRATION_MODE=${REGISTRATION_MODE}
REGISTRATION_DEFAULT_ROLE=${REGISTRATION_DEFAULT_ROLE}

${db_block}
${redis_block}

TELEMETRY_DEFAULT_SECONDS=5
TELEMETRY_CLOSE_SECONDS=1
TELEMETRY_CLOSE_AGL_M=15000
EOF
    chown root:"$DEPLOY_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
    ok "env file written (root:${DEPLOY_USER} 640)"
}

# -----------------------------------------------------------------------------
# 15. systemd unit
# -----------------------------------------------------------------------------
step_systemd() {
    log "Installing systemd unit: ksctower-backend.service"
    cat >"$SYSTEMD_UNIT" <<EOF
[Unit]
Description=KSCTowerNetwork backend (node)
After=network-online.target mariadb.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
WorkingDirectory=${BACKEND_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
# Give up if it crash-loops (5 starts in 60s) so we don't pound the box on bad config.
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

# hardening (NOTE: MemoryDenyWriteExecute is intentionally OMITTED — it breaks
# V8's JIT and Node will crash on startup. The other knobs are V8-safe.)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${BACKEND_DIR}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictNamespaces=true
RestrictRealtime=true
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable ksctower-backend.service
    systemctl restart ksctower-backend.service
    sleep 2
    if ! systemctl is-active --quiet ksctower-backend.service; then
        err "backend failed to start. Showing last logs:"
        journalctl -u ksctower-backend.service -n 50 --no-pager || true
        exit 3
    fi
    ok "ksctower-backend.service active"
}

# -----------------------------------------------------------------------------
# 16. nginx site
# -----------------------------------------------------------------------------
step_nginx_site() {
    log "Writing nginx site for $DOMAIN"
    rm -f /etc/nginx/sites-enabled/default || true

    # When behind Cloudflare, write a global include that tells nginx to trust
    # CF-Connecting-IP from CF edge ranges. This makes $remote_addr the REAL
    # client IP, which makes nginx access logs, rate limits, and any future
    # fail2ban-on-nginx jail actually meaningful (otherwise they all see
    # 172.x.x.x Cloudflare IPs and any abuse → ban Cloudflare → outage).
    if [[ "$BEHIND_CLOUDFLARE" == "1" ]]; then
        {
            echo "# AUTO-GENERATED by setup-vps.sh — refreshed weekly by refresh-cloudflare-ips.timer"
            while IFS= read -r cidr; do [[ -n "$cidr" ]] && echo "set_real_ip_from $cidr;"; done </etc/cloudflare/ips-v4
            while IFS= read -r cidr; do [[ -n "$cidr" ]] && echo "set_real_ip_from $cidr;"; done </etc/cloudflare/ips-v6
            echo "real_ip_header CF-Connecting-IP;"
            echo "real_ip_recursive on;"
        } >/etc/nginx/conf.d/cloudflare-realip.conf
    else
        rm -f /etc/nginx/conf.d/cloudflare-realip.conf
    fi

    # Cert paths: CF Origin Cert (15-yr, no renewal) when behind Cloudflare,
    # otherwise we let certbot drop in Let's Encrypt paths during step_certbot.
    # When the Authenticated-Origin-Pulls CA is on disk, also enforce
    # ssl_verify_client — even an attacker who knows the origin IP and somehow
    # bypassed the UFW allowlist still can't talk to nginx without Cloudflare's
    # client cert.
    local cert_block aop_block=""
    if [[ "$BEHIND_CLOUDFLARE" == "1" ]]; then
        cert_block=$(cat <<EOF
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    ssl_certificate     ${CF_ORIGIN_CERT_PATH};
    ssl_certificate_key ${CF_ORIGIN_KEY_PATH};
EOF
)
        if [[ -s "$CF_AOP_CA_PATH" ]]; then
            aop_block=$(cat <<EOF
    ssl_client_certificate ${CF_AOP_CA_PATH};
    ssl_verify_client on;
EOF
)
        fi
    else
        # Placeholder — certbot --nginx replaces this block with real LE paths.
        cert_block="    # certbot will inject listen 443 + ssl_certificate here"
    fi

    cat >"$NGINX_SITE" <<EOF
# Plain HTTP listener.
#  - BEHIND_CLOUDFLARE=1: only Cloudflare edges can reach this (UFW-restricted).
#                         CF terminates 80 itself; this block exists only as a
#                         safety net + redirect.
#  - BEHIND_CLOUDFLARE=0: certbot --nginx will rewrite this to redirect to 443.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    server_name ${DOMAIN};
${cert_block}
${aop_block}
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Defence-in-depth headers (Cloudflare may strip / re-add some of these,
    # which is fine — origin enforcing them protects the bypass-direct case).
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(self), geolocation=()" always;

    root ${WEB_DIR}/dist;
    index index.html;

    # API + websockets → backend
    location /v1/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        client_max_body_size 25m;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;
}
EOF
    ln -sfn "$NGINX_SITE" "$NGINX_LINK"
    nginx -t
    systemctl reload nginx
    ok "nginx site live"
}

# -----------------------------------------------------------------------------
# 17. TLS via Let's Encrypt
# -----------------------------------------------------------------------------
step_certbot() {
    if [[ "$BEHIND_CLOUDFLARE" == "1" ]]; then
        ok "Skipping Let's Encrypt — using Cloudflare Origin Certificate (15-yr, no renewal)"
        return
    fi
    log "Requesting TLS cert for $DOMAIN"
    certbot --nginx \
        --non-interactive --agree-tos \
        --redirect --hsts \
        --email "$LETSENCRYPT_EMAIL" \
        -d "$DOMAIN"
    systemctl enable --now certbot.timer
    ok "HTTPS active for https://${DOMAIN}/"
}

# -----------------------------------------------------------------------------
# 17b. Verify Cloudflare bypass is actually blocked
# -----------------------------------------------------------------------------
step_verify_origin_lockdown() {
    [[ "$BEHIND_CLOUDFLARE" == "1" ]] || { ok "Lockdown verification skipped (not behind CF)"; return; }
    log "Verifying origin lockdown (direct-to-IP must fail, via-CF must succeed)"

    local ip="$CF_VPS_PUBLIC_IP"
    if [[ -z "$ip" ]]; then ip="$(curl -fsS https://api.ipify.org || true)"; fi
    if [[ -z "$ip" ]]; then warn "Could not determine public IP; skipping bypass test."; return; fi

    # Test 1: connect directly to the VPS IP, claiming the right hostname via SNI.
    # Should fail with timeout / connection refused (UFW dropped the SYN).
    if curl -m 8 -sk --resolve "${DOMAIN}:443:${ip}" "https://${DOMAIN}/" -o /dev/null 2>/dev/null; then
        err "BYPASS POSSIBLE: direct connection to ${ip}:443 succeeded."
        err "  UFW is not blocking non-Cloudflare sources. Investigate before going live."
        err "  Check: ufw status verbose"
    else
        ok "Direct-to-origin connection blocked (good — CF cannot be bypassed)"
    fi

    # Test 2: connect via DNS (which resolves to Cloudflare). Should succeed.
    # Note: this only works if DNS has propagated. Brand-new A records may take
    # a moment; not fatal if it 5xx's at this exact second.
    local code
    code="$(curl -m 15 -sk -o /dev/null -w '%{http_code}' "https://${DOMAIN}/" || echo 000)"
    if [[ "$code" =~ ^(200|301|302|304|401|403|404)$ ]]; then
        ok "Via Cloudflare: HTTP $code"
    else
        warn "Via Cloudflare returned HTTP $code — may be DNS propagation delay; recheck in 1-2 min."
    fi
}

# -----------------------------------------------------------------------------
# 18. Summary
# -----------------------------------------------------------------------------
print_summary() {
    cat <<EOF

${C_GREEN}=============================================================${C_RESET}
${C_GREEN}  KSCTowerNetwork is live${C_RESET}
${C_GREEN}=============================================================${C_RESET}

  Web:        https://${DOMAIN}/
  Backend:    127.0.0.1:${BACKEND_PORT}  (proxied at /v1/)
  Env file:   ${ENV_FILE}
  Repo:       ${APP_REPO_DIR}
  Systemd:    systemctl status ksctower-backend
  Logs:       journalctl -u ksctower-backend -f

  SSH:        ssh -p ${SSH_PORT} ${DEPLOY_USER}@${DOMAIN}
              (root login disabled, password auth disabled)

  Firewall:   ufw status
  Fail2ban:   fail2ban-client status sshd
  TLS renew:  systemctl list-timers certbot.timer

NEXT STEPS
  1. Open a SECOND ssh session as ${DEPLOY_USER} and confirm key login works
     BEFORE closing this one.
  2. Visit https://${DOMAIN}/ and log in with the credentials you set
     in WEB_LOGIN_USERS_JSON.

  Cloudflare zone settings, DNS A record, Origin Cert, and Authenticated Origin
  Pulls were applied by step_cloudflare_api. Origin lockdown was verified by
  step_verify_origin_lockdown. Nothing left to click in the dashboard unless
  you want to enable extras (Page Rules, Custom WAF rules, etc.).
  3. Build/package the player plugin and bridge separately using the Development guide.
     Configure release-config.json backend.origin and web.origin for https://${DOMAIN}.
     Existing players can change runtime server settings; no hardcoded C# URL edit is needed.
  4. Migrate WEB_LOGIN_USERS_JSON entries from "password" to "passwordHash"
     (argon2id) per HOSTING.md §8 — backend is logging a WARN until you do.

TO REDEPLOY (after pushing to ${APP_BRANCH}):
  sudo -u ${DEPLOY_USER} git -C ${APP_REPO_DIR} pull
  sudo -u ${DEPLOY_USER} bash -lc "cd ${BACKEND_DIR} && npm ci && npm run build"
  sudo -u ${DEPLOY_USER} bash -lc "cd ${WEB_DIR} && VITE_API_BASE='' npm ci && npm run build"
  sudo systemctl restart ksctower-backend

EOF
}

# =============================================================================
main() {
    require_root
    require_ubuntu
    require_config

    step_apt
    step_unattended_upgrades
    step_deploy_user
    step_firewall              # firewall before sshd reload, so we don't lock ourselves out via the new port
    step_cloudflare_refresh    # weekly timer + script that keeps CF IP allowlist current
    step_harden_ssh
    step_fail2ban
    step_swap
    step_node
    step_nginx
    step_cloudflare_api        # mints Origin Cert + applies CF zone settings (or no-op if not behind CF)
    step_mariadb
    step_redis
    step_clone
    step_build
    step_env_file
    step_systemd
    step_nginx_site
    step_certbot
    step_verify_origin_lockdown
    print_summary
}

main "$@"
