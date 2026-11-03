#!/bin/bash
# One-shot setup for an Ubuntu 24.04 EC2 instance. Paste as "User data" when launching.
# Installs Node 24 + Caddy (automatic HTTPS on <ip>.sslip.io), clones the repo, runs the app as a service.
# Secrets are NOT in this script: afterwards run  sudo nano /opt/claimdocs/.env  and fill the three keys.
set -euxo pipefail
REPO=https://github.com/Karman-singh15/carefi-whatsapp-tracker.git
APP=/opt/claimdocs
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl git gnupg debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

useradd --system --home "$APP" --shell /usr/sbin/nologin claimdocs || true
git clone "$REPO" "$APP"
cd "$APP" && npm ci --omit=dev
mkdir -p /var/lib/claimdocs && chown claimdocs: /var/lib/claimdocs

T=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
IP=$(curl -s -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/public-ipv4)
HOST="${IP//./-}.sslip.io"

cat > "$APP/.env" <<EOF
GEMINI_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_WHATSAPP_FROM=+14155238886
REPLY_MODE=twiml
AGENTS=agent:$(openssl rand -base64 18 | tr -d '/+=')
SESSION_SECRET=$(openssl rand -hex 32)
DATA_DIR=/var/lib/claimdocs
PORT=3000
PUBLIC_URL=https://$HOST
EOF
chown claimdocs: "$APP/.env" && chmod 600 "$APP/.env"

cat > /etc/systemd/system/claimdocs.service <<EOF
[Unit]
Description=Claim Docs (WhatsApp document tracker)
After=network-online.target
[Service]
User=claimdocs
WorkingDirectory=$APP
ExecStart=/usr/bin/npm start
Restart=always
[Install]
WantedBy=multi-user.target
EOF

printf '%s {\n  reverse_proxy localhost:3000\n}\n' "$HOST" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now claimdocs
systemctl restart caddy
echo "https://$HOST" > /root/claimdocs-url.txt
