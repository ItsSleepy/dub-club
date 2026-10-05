#!/usr/bin/env bash
# Puts Dub Club on https://dub.isaac-dev.eu
# Run once, after the Cloudflare DNS record exists:  bash ~/dub-club/deploy/enable-subdomain.sh
set -euo pipefail

SITE=dub.isaac-dev.eu
SRC="$(dirname "$0")/$SITE"

if [ -z "$(dig +short "$SITE" @1.1.1.1)" ]; then
  echo "DNS for $SITE doesn't resolve yet. Add the Cloudflare record first, wait a minute, then rerun."
  exit 1
fi

sudo cp "$SRC" "/etc/nginx/sites-available/$SITE"
sudo ln -sf "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d "$SITE" --redirect --non-interactive --agree-tos
sudo systemctl reload nginx

echo "Done. Open https://$SITE"
