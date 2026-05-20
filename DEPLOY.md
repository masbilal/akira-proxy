# Panduan Deploy ke VPS Ubuntu CloudPanel

Panduan lengkap untuk deploy **Akira Proxy** ke VPS Ubuntu dengan CloudPanel sebagai hub sinkronisasi.

## Prasyarat

- VPS Ubuntu 20.04/22.04/24.04 dengan CloudPanel sudah terinstall
- Domain yang sudah diarahkan ke IP VPS (contoh: `router.example.com`)
- Akses SSH ke VPS
- Node.js 22.5+ (akan diinstall di langkah 1)

## Langkah 1: Install Node.js 22.x

SSH ke VPS sebagai root atau user dengan sudo:

```bash
# Install Node.js 22.x dari NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verifikasi instalasi
node --version  # harus >= v22.5.0
npm --version
```

## Langkah 2: Buat Site di CloudPanel

1. Login ke CloudPanel dashboard (`https://your-vps-ip:8443`)
2. Klik **Sites** → **Add Site**
3. Pilih **Node.js**
4. Isi form:
   - **Domain Name**: `router.example.com`
   - **Site User**: biarkan default atau sesuaikan
   - **App Port**: `3000`
   - **App Root**: `/home/siteuser/htdocs/router.example.com` (default)
   - **Startup File**: `src/server.js`
5. Klik **Create**

CloudPanel akan membuat:
- User sistem untuk site
- Direktori site di `/home/siteuser/htdocs/router.example.com`
- Nginx reverse proxy yang forward port 80/443 → 3000
- Systemd service untuk auto-restart

## Langkah 3: Upload Kode ke VPS

### Opsi A: Git Clone (Recommended)

SSH sebagai site user:

```bash
# Login sebagai site user (ganti 'siteuser' dengan user yang dibuat CloudPanel)
sudo su - siteuser
cd ~/htdocs/router.example.com

# Clone repo (ganti URL dengan repo Anda)
git clone https://github.com/masbilal/akira-proxy.git .

# Atau jika sudah ada repo lokal, push ke VPS via git
```

### Opsi B: Upload Manual via SFTP

Gunakan FileZilla/WinSCP untuk upload semua file ke `/home/siteuser/htdocs/router.example.com`.

## Langkah 4: Install Dependencies

Masih sebagai site user:

```bash
cd ~/htdocs/router.example.com
npm install
```

## Langkah 5: Konfigurasi Environment

```bash
# Copy template .env
cp .env.example .env

# Edit .env
nano .env
```

Isi minimal yang **wajib** diubah:

```env
# Admin dashboard login
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<password-kuat-anda>

# Session secret (generate dengan: openssl rand -hex 32)
SESSION_SECRET=<random-string-panjang>

# Sync configuration (VPS = hub)
SYNC_MODE=hub
SYNC_NODE_ID=vps-prod
SYNC_SECRET=<openssl rand -hex 32>

# MySQL backup (CloudPanel sudah install MySQL)
BACKUP_ENABLED=1
BACKUP_MYSQL_HOST=127.0.0.1
BACKUP_MYSQL_PORT=3306
BACKUP_MYSQL_USER=siteuser
BACKUP_MYSQL_PASSWORD=<password-mysql-dari-cloudpanel>
BACKUP_MYSQL_DATABASE=akira_proxy

# Production settings
NODE_ENV=production
SESSION_SECURE_COOKIE=1
```

**Cara dapat MySQL password:**
- CloudPanel → Sites → klik site Anda → tab **Databases**
- Lihat password user database yang sudah dibuat otomatis
- Atau buat database baru dengan nama `akira_proxy`

## Langkah 6: Setup Database

```bash
# Jalankan migrasi
npm run migrate

# Seed data awal (provider Kiro/Codex)
npm run seed
```

## Langkah 7: Setup SSL/TLS

1. CloudPanel → Sites → pilih site Anda
2. Tab **SSL/TLS**
3. Klik **New Let's Encrypt Certificate**
4. Centang domain, klik **Create and Install**

CloudPanel akan:
- Request sertifikat dari Let's Encrypt
- Install ke Nginx
- Auto-renew sebelum expire

## Langkah 8: Start Aplikasi

CloudPanel sudah membuat systemd service. Restart dari dashboard:

1. CloudPanel → Sites → pilih site
2. Tab **Node.js**
3. Klik **Restart**

Atau via SSH:

```bash
# Sebagai root atau sudo
sudo systemctl restart router.example.com

# Cek status
sudo systemctl status router.example.com

# Lihat logs
sudo journalctl -u router.example.com -f
```

## Langkah 9: Verifikasi Deployment

```bash
# Health check
curl https://router.example.com/healthz
# Expected: {"ok":true}

# Sync status (ganti SYNC_SECRET dengan nilai dari .env)
curl -H "Authorization: Bearer YOUR_SYNC_SECRET" \
     https://router.example.com/api/sync/status
# Expected: {"mode":"hub","nodeId":"vps-prod",...}
```

Buka browser: `https://router.example.com`
- Login dengan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` dari `.env`
- Dashboard harus muncul

## Langkah 10: Setup Peer (Lokal)

Di komputer lokal Anda:

```bash
cd /path/to/akira-proxy
cp .env.example .env
nano .env
```

Konfigurasi peer:

```env
# Local settings
PORT=3000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
SESSION_SECRET=<random-string-berbeda-dari-vps>

# Sync configuration (Local = peer)
SYNC_MODE=peer
SYNC_NODE_ID=laptop-dewa
SYNC_HUB_URL=https://router.example.com
SYNC_SECRET=<sama-dengan-vps>
SYNC_INTERVAL_MS=15000

# Disable MySQL backup di lokal (opsional)
BACKUP_ENABLED=0
```

Jalankan:

```bash
npm install
npm run migrate
npm run seed
npm start
```

Dalam 15 detik, provider dan akun dari VPS akan muncul di dashboard lokal.

## Langkah 11: Test Sinkronisasi

### Test 1: VPS → Lokal

Di VPS dashboard (`https://router.example.com`):
1. Login
2. Accounts → Add Account
3. Isi form, Save

Di lokal (`http://localhost:3000`):
- Refresh dashboard dalam 15 detik
- Akun baru harus muncul dengan label `node_id: vps-prod`

### Test 2: Lokal → VPS

Di lokal:
1. Tambah provider baru atau model baru
2. Tunggu 15 detik

Di VPS:
- Refresh dashboard
- Provider/model baru harus muncul dengan `node_id: laptop-dewa`

## Troubleshooting

### 1. Aplikasi tidak start

```bash
# Cek logs
sudo journalctl -u router.example.com -n 50

# Cek port 3000 sudah dipakai atau belum
sudo netstat -tlnp | grep 3000

# Test manual
cd /home/siteuser/htdocs/router.example.com
node src/server.js
```

### 2. Sync gagal: "handshake returned 401"

- `SYNC_SECRET` di lokal dan VPS harus **identik**
- Cek typo atau whitespace di `.env`

### 3. Sync gagal: "ENOTFOUND" atau "ECONNREFUSED"

```bash
# Dari lokal, test koneksi ke VPS
curl -I https://router.example.com/healthz

# Jika gagal, cek:
# - DNS sudah propagasi?
# - Firewall VPS allow port 443?
# - Nginx running?
sudo systemctl status nginx
```

### 4. MySQL backup error: "Access denied"

```bash
# Cek user MySQL bisa akses database
mysql -u siteuser -p akira_proxy
# Masukkan password dari .env

# Jika database belum ada, buat manual:
mysql -u root -p
CREATE DATABASE akira_proxy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON akira_proxy.* TO 'siteuser'@'localhost';
FLUSH PRIVILEGES;
```

### 5. SSL certificate error

- Pastikan domain sudah pointing ke IP VPS (cek `dig router.example.com`)
- CloudPanel butuh port 80 terbuka untuk Let's Encrypt validation
- Coba manual: CloudPanel → SSL/TLS → Delete cert → Create new

### 6. Outbox membengkak

```bash
# Cek ukuran outbox
sqlite3 /home/siteuser/htdocs/router.example.com/data/akira-proxy.db \
  "SELECT COUNT(*) FROM sync_outbox;"

# Jika > 10000 dan semua peer sudah sync, aman untuk truncate:
# (Cek dulu cursor terendah di sync_peers)
sqlite3 /home/siteuser/htdocs/router.example.com/data/akira-proxy.db \
  "SELECT node_id, MIN(last_pull_outbox_id) FROM sync_peers;"

# Hapus outbox lama (ganti 5000 dengan cursor terendah)
sqlite3 /home/siteuser/htdocs/router.example.com/data/akira-proxy.db \
  "DELETE FROM sync_outbox WHERE id < 5000;"
```

## Maintenance

### Update Aplikasi

```bash
# SSH sebagai site user
sudo su - siteuser
cd ~/htdocs/router.example.com

# Pull update
git pull origin main

# Install dependencies baru (jika ada)
npm install

# Jalankan migrasi baru (jika ada)
npm run migrate

# Restart
sudo systemctl restart router.example.com
```

### Backup Database

```bash
# Backup SQLite
cp /home/siteuser/htdocs/router.example.com/data/akira-proxy.db \
   /home/siteuser/backups/akira-proxy-$(date +%Y%m%d).db

# Backup MySQL (otomatis via app, atau manual)
mysqldump -u siteuser -p akira_proxy > akira-proxy-backup.sql
```

### Monitor Logs

```bash
# Real-time logs
sudo journalctl -u router.example.com -f

# Logs 1 jam terakhir
sudo journalctl -u router.example.com --since "1 hour ago"

# Cari error
sudo journalctl -u router.example.com | grep -i error
```

### Restart Otomatis Jika Crash

CloudPanel systemd service sudah include `Restart=always`, tapi bisa diperkuat:

```bash
# Edit service
sudo systemctl edit router.example.com

# Tambahkan:
[Service]
Restart=always
RestartSec=10
```

## Keamanan Tambahan

### 1. Firewall (UFW)

```bash
# Allow SSH, HTTP, HTTPS, CloudPanel
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8443/tcp
sudo ufw enable
```

### 2. Fail2ban untuk Brute Force Protection

```bash
sudo apt-get install fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### 3. Rate Limiting di Nginx

CloudPanel → Sites → Nginx Settings → tambahkan di `location /`:

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req zone=api_limit burst=20 nodelay;
```

### 4. Rotate Secrets Berkala

Setiap 3-6 bulan:
1. Generate `SYNC_SECRET` baru
2. Update `.env` di VPS dan semua peer
3. Restart semua instance

## Monitoring & Alerting

### Setup Uptime Monitoring

Gunakan layanan gratis seperti:
- [UptimeRobot](https://uptimerobot.com) (50 monitor gratis)
- [Freshping](https://www.freshworks.com/website-monitoring/)

Monitor endpoint:
- `https://router.example.com/healthz` (setiap 5 menit)
- Alert via email/Telegram jika down

### CloudPanel Built-in Monitoring

CloudPanel → Sites → Monitoring:
- CPU usage
- Memory usage
- Disk space
- Request rate

## Skalabilitas

### Multiple Peers

Tambahkan peer sebanyak yang Anda mau:
- Laptop kerja: `SYNC_NODE_ID=laptop-work`
- Laptop rumah: `SYNC_NODE_ID=laptop-home`
- Server kantor: `SYNC_NODE_ID=office-server`

Semua akan sync ke hub VPS yang sama.

### Load Balancing (Advanced)

Jika traffic tinggi, setup multiple hub:
1. Deploy instance kedua di VPS berbeda
2. Setup MySQL replication antar VPS
3. Gunakan CloudFlare Load Balancer atau Nginx upstream

## Biaya Estimasi

- **VPS**: $5-10/bulan (DigitalOcean, Vultr, Linode)
- **Domain**: $10-15/tahun
- **CloudPanel**: Gratis (open source)
- **Let's Encrypt SSL**: Gratis
- **Total**: ~$7/bulan

## Referensi

- [CloudPanel Docs](https://www.cloudpanel.io/docs/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Let's Encrypt](https://letsencrypt.org/)
- [PM2 Alternative](https://pm2.keymetrics.io/) (jika tidak pakai CloudPanel systemd)

## Support

Jika ada masalah:
1. Cek logs: `sudo journalctl -u router.example.com -n 100`
2. Cek status sync: `GET /api/admin/sync/status` (butuh login)
3. Buka issue di repo GitHub

---

**Selamat! Akira Proxy sekarang running di VPS dan sync otomatis dengan lokal.** 🚀
