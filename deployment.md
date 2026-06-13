# Deployment Guide — ToDoListv2 on Azure Linux VM + Application Gateway + Cosmos DB

This guide covers deploying the app onto an already-provisioned Azure Linux VM, fronted by an Azure Application Gateway, with data stored in Azure Cosmos DB (MongoDB API). It does **not** cover provisioning the cloud resources themselves.

---

## 1. Prepare the code for production

### 1.1 Pin a Node version & add scripts
Edit `package.json`:
```json
{
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "start": "node app.js"
  }
}
```

### 1.2 Bind to `0.0.0.0` and use `PORT` from env
In `app.js`:
```js
app.listen(PORT, '0.0.0.0', () => console.log(`Live on ${PORT}`));
```

### 1.3 Trust the proxy (App Gateway terminates TLS)
Add **before** any routes:
```js
app.set('trust proxy', 1);
```
This ensures `req.protocol`, `req.ip`, and secure-cookie logic see the original client IP/scheme from the `X-Forwarded-*` headers App Gateway sends.

### 1.4 Add a health-probe endpoint
App Gateway needs a 200 from a known path:
```js
app.get('/health', (req, res) => res.status(200).send('ok'));
```

### 1.5 Lock down the `.env`
- Confirm `.env` is in `.gitignore`.
- Never commit it. You'll create it directly on the VM.

### 1.6 Commit & push to a Git remote (GitHub / Azure Repos)
```powershell
git add .
git commit -m "Prep for Azure deployment"
git push
```

---

## 2. Cosmos DB connection string

In the Azure Portal → your Cosmos DB account (MongoDB API) → **Connection strings** → copy the **PRIMARY CONNECTION STRING**:
```
mongodb://<account>:<key>@<account>.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@<account>@
```

> **Important for Cosmos DB Mongo API:** append a database name before the `?`, e.g. `.../todolist?ssl=true&...`. Cosmos requires `retrywrites=false`.

You'll paste this into `/etc/todolist.env` on the VM in step 4.

---

## 3. On the VM — install runtime dependencies

SSH in:
```bash
ssh azureuser@<vm-public-ip>
```

Install Node.js 20 LTS (Ubuntu/Debian example):
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v && npm -v
```

Create a dedicated non-root user to run the app:
```bash
sudo useradd -r -m -s /bin/bash todolist
```

---

## 4. Deploy the code

```bash
sudo mkdir -p /opt/todolist
sudo chown todolist:todolist /opt/todolist
sudo -u todolist git clone https://github.com/<you>/ToDoListv2.git /opt/todolist/app
cd /opt/todolist/app
sudo -u todolist npm ci --omit=dev
```

Create the environment file (root-owned, readable only by the service user):
```bash
sudo tee /etc/todolist.env > /dev/null <<'EOF'
MONGODB_URI=mongodb://<account>:<key>@<account>.mongo.cosmos.azure.com:10255/todolist?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@<account>@
PORT=3000
NODE_ENV=production
EOF
sudo chown root:todolist /etc/todolist.env
sudo chmod 640 /etc/todolist.env
```

---

## 5. Run as a systemd service

Create `/etc/systemd/system/todolist.service`:
```ini
[Unit]
Description=ToDoList Node app
After=network.target

[Service]
Type=simple
User=todolist
WorkingDirectory=/opt/todolist/app
EnvironmentFile=/etc/todolist.env
ExecStart=/usr/bin/node app.js
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/todolist/app

[Install]
WantedBy=multi-user.target
```

Enable & start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now todolist
sudo systemctl status todolist
sudo journalctl -u todolist -f      # live logs
```

You should see `Live on 3000`. Test locally on the VM:
```bash
curl http://127.0.0.1:3000/health
```

---

## 6. Front the app with Nginx (recommended)

Application Gateway → Nginx (on the VM) → Node. Nginx handles keep-alives, gzip, static caching, and graceful 502 pages.

```bash
sudo apt-get install -y nginx
sudo tee /etc/nginx/sites-available/todolist > /dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;

    # Health probe from App Gateway
    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        access_log off;
    }

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_read_timeout 60s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/todolist /etc/nginx/sites-enabled/todolist
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7. Firewall

Only the App Gateway subnet should reach the VM. On the VM:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw enable
```
In Azure, the NSG on the VM's NIC/subnet should restrict inbound `80` to the **App Gateway subnet** only, and `22` to your admin IP.

---

## 8. Application Gateway — app-side settings to know

For the app to work behind the gateway, confirm:
- **Backend pool**: VM private IP.
- **Backend HTTP setting**: port `80`, protocol HTTP, *Use custom probe*.
- **Custom health probe**: path `/health`, port 80, expected status `200`.
- **Listener**: HTTPS 443 with your certificate; HTTP 80 → redirect to HTTPS.
- **Cookie-based affinity**: enable only if you later add server-side sessions (not needed for this app today).

---

## 9. Updating / redeploying

```bash
cd /opt/todolist/app
sudo -u todolist git pull
sudo -u todolist npm ci --omit=dev
sudo systemctl restart todolist
```

For zero-downtime updates later, deploy to `/opt/todolist/releases/<timestamp>` and switch a `current` symlink before `systemctl restart`.

---

## 10. Post-deployment checklist

- [ ] `curl http://<vm-private-ip>/health` from another VM in the VNet returns `ok`.
- [ ] App Gateway backend health shows **Healthy**.
- [ ] `https://<your-domain>/` loads the to-do list.
- [ ] `journalctl -u todolist` shows no Mongoose connection errors.
- [ ] Cosmos DB metrics show successful requests.
- [ ] `.env` is **not** in your Git repo (`git log --all -- .env` is empty).
- [ ] The Cosmos DB password used here is **not** the one previously committed to the repo (rotated).
- [ ] App Gateway has **WAF** enabled (recommended).
- [ ] Diagnostic logs from App Gateway + VM are flowing to a Log Analytics workspace.

---

## Optional improvements before going live

- Add `helmet` middleware (`npm i helmet` → `app.use(helmet())`) for secure HTTP headers.
- Add `express-rate-limit` to throttle `POST /` and `POST /delete`.
- Use **Managed Identity + Azure Key Vault** instead of `.env` for the Mongo connection string.
- Configure `logrotate` or send `journalctl` output to Azure Monitor via the Azure Monitor Agent.
