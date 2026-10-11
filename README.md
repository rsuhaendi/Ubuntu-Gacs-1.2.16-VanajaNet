# genieacs-1.2.16-VanajaNet
# Full Auto Backup Script (Ubuntu 22.04 LTS)

Repository ini berisi panduan instalasi lengkap, konfigurasi sistem, dan skrip otomatisasi untuk **GenieACS** di sistem operasi Ubuntu 22.04 LTS. Berkas ini dilengkapi dengan fitur **Full Auto Backup & Restore ke GitHub** untuk seluruh konfigurasi Web GUI (Admin & Database).

---

## 📋 Fitur Utama
* **Kompatibilitas Multi-Vendor**: Mendukung TR-069 data model `Device` dan `InternetGatewayDevice` (Ruijie, ZTE, Fiberhome, Mikrotik, Huawei, V-SOL, dll.).
* **Full Auto Backup & Restore**: Cadangkan dan pulihkan otomatis seluruh *Provisions*, *Presets*, *Virtual Parameters*, *Index Fields*, *Config*, *Permissions*, *Users*, dan *Files (GridFS)* via Git.
* **Integrasi Extensions & MikroTik**: Mendukung skrip Node.js kustom di `/opt/genieacs/ext`.

---

## 🚀 Langkah Instalasi di Ubuntu 22.04 LTS

### 1. Update Server & Install MongoDB 6.0 Resmi
```bash
# Hapus sisa repositori mongodb lama yang rusak jika ada
sudo rm -f /etc/apt/sources.list.d/mongodb*

# Update dan install dependensi dasar
sudo apt update -y
sudo apt install -y curl build-essential git ca-certificates gnupg apt-transport-https

# Tambah Key & Repo Resmi MongoDB 6.0
curl -fsSL https://pgp.mongodb.com/server-6.0.asc | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-6.0.gpg
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list

# Install MongoDB dan Database Tools Resmi (mongoimport/mongoexport)
sudo apt update
sudo apt install -y mongodb-org mongodb-database-tools mongodb-mongosh
sudo systemctl enable --now mongod
```

---
### 3. Install Nodejs & GenieACS termasuk Extention RouterOs-Client
```bash
# 1. Install Node.js v20 (Sistem)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Install GenieACS secara global
sudo npm install -g genieacs@1.2.16

# 3. Buat direktori kerja untuk ekstensi dan atur hak akses
sudo mkdir -p /opt/genieacs/ext
sudo chown -R $USER:$USER /opt/genieacs

# 4. Masuk ke direktori ekstensi GenieACS
cd /opt/genieacs/ext

# 5. Inisialisasi npm project & install routeros-client
npm init -y
npm install routeros-client

# 6. Beri izin eksekusi pada file JavaScript ekstensi (misal: mikrotik.js)
chmod +x /opt/genieacs/ext/*.js
```

---

### 3. Buat File Environment GenieACS
```bash
sudo mkdir -p /etc/genieacs

sudo bash -c 'cat <<EOF> /etc/genieacs/genieacs.env
GENIEACS_CWMP_PORT=9901
GENIEACS_NBI_PORT=7557
GENIEACS_FS_PORT=7567
GENIEACS_UI_PORT=3000
GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1/genieacs
GENIEACS_JWT_SECRET=SystemPassword
GENIEACS_UI_JWT_SECRET=SystemPassword
GENIEACS_EXT_DIR=/opt/genieacs/ext
EOF'

# Simbolik link untuk kompatibilitas service
sudo ln -sf /etc/genieacs/genieacs.env /etc/genieacs.env
```

---

### 4. Setup Service Systemd GenieACS

Buat service otomatis untuk 4 komponen GenieACS:

```bash
# 1. genieacs-cwmp
sudo bash -c 'cat <<EOF> /etc/systemd/system/genieacs-cwmp.service
[Unit]
Description=GenieACS CWMP
After=network.target

[Service]
User=root
EnvironmentFile=/etc/genieacs/genieacs.env
ExecStart=/usr/bin/genieacs-cwmp

[Install]
WantedBy=multi-user.target
EOF'

# 2. genieacs-nbi
sudo bash -c 'cat <<EOF> /etc/systemd/system/genieacs-nbi.service
[Unit]
Description=GenieACS NBI
After=network.target

[Service]
User=root
EnvironmentFile=/etc/genieacs/genieacs.env
ExecStart=/usr/bin/genieacs-nbi

[Install]
WantedBy=multi-user.target
EOF'

# 3. genieacs-fs
sudo bash -c 'cat <<EOF> /etc/systemd/system/genieacs-fs.service
[Unit]
Description=GenieACS FS
After=network.target

[Service]
User=root
EnvironmentFile=/etc/genieacs/genieacs.env
ExecStart=/usr/bin/genieacs-fs

[Install]
WantedBy=multi-user.target
EOF'

# 4. genieacs-ui
sudo bash -c 'cat <<EOF> /etc/systemd/system/genieacs-ui.service
[Unit]
Description=GenieACS UI
After=network.target

[Service]
User=root
EnvironmentFile=/etc/genieacs/genieacs.env
ExecStart=/usr/bin/genieacs-ui

[Install]
WantedBy=multi-user.target
EOF'

# Muat ulang & aktifkan semua service
sudo systemctl daemon-reload
sudo systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
sudo systemctl enable genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
```

---

## 📦 Connecting Repository & Restore Configuration

### 1. Hubungkan Repository & Tarik Berkas Backup
```bash
cd /opt/genieacs/ext
git init
git remote add origin https://github.com/rsuhaendi/genieacs-1.2.16-VanajaNet.git 2>/dev/null || git remote set-url origin https://github.com/rsuhaendi/Ubuntu-Gacs-1.2.16-VanajaNet.git
git config --global credential.helper store
git fetch origin
git reset --hard origin/main

# Pasang otomatis seluruh pustaka Node.js dari package.json hasil sync Git
npm install
```

---

### 2. Membuat Skrip Restore Konfigurasi (`restore_from_git.sh`)
```bash
cat << 'EOF' > /opt/genieacs/ext/restore_from_git.sh
#!/bin/bash

BASE_DIR="/opt/genieacs/ext"
DB_NAME="genieacs"

echo "=== Memperbarui File Extension & Backup dari Git ==="
cd "$BASE_DIR" || exit
git pull origin main

echo "=== Memulai Import Konfigurasi GenieACS ke MongoDB ==="

# 1. Restore Provisions
if [ -f "$BASE_DIR/provisions/provisions_backup.json" ]; then
  echo "Importing provisions..."
  mongoimport --db=$DB_NAME --collection=provisions --file="$BASE_DIR/provisions/provisions_backup.json" --jsonArray --drop
fi

# 2. Restore Presets
if [ -f "$BASE_DIR/presets/presets_backup.json" ]; then
  echo "Importing presets..."
  mongoimport --db=$DB_NAME --collection=presets --file="$BASE_DIR/presets/presets_backup.json" --jsonArray --drop
fi

# 3. Restore Virtual Parameters
if [ -f "$BASE_DIR/virtual_parameters/vp_backup.json" ]; then
  echo "Importing virtualParameters..."
  mongoimport --db=$DB_NAME --collection=virtualParameters --file="$BASE_DIR/virtual_parameters/vp_backup.json" --jsonArray --drop
fi

# 4. Restore Index Fields
if [ -f "$BASE_DIR/index_fields/index_fields_backup.json" ]; then
  echo "Importing indexFields..."
  mongoimport --db=$DB_NAME --collection=indexFields --file="$BASE_DIR/index_fields/index_fields_backup.json" --jsonArray --drop
fi

# 5. Restore Config
if [ -f "$BASE_DIR/config/config_backup.json" ]; then
  echo "Importing config..."
  mongoimport --db=$DB_NAME --collection=config --file="$BASE_DIR/config/config_backup.json" --jsonArray --drop
fi

# 6. Restore Permissions
if [ -f "$BASE_DIR/permissions/permissions_backup.json" ]; then
  echo "Importing permissions..."
  mongoimport --db=$DB_NAME --collection=permissions --file="$BASE_DIR/permissions/permissions_backup.json" --jsonArray --drop
fi

# 7. Restore Users
if [ -f "$BASE_DIR/users/users_backup.json" ]; then
  echo "Importing users..."
  mongoimport --db=$DB_NAME --collection=users --file="$BASE_DIR/users/users_backup.json" --jsonArray --drop
fi

# 8. Restore Files (GridFS)
if [ -f "$BASE_DIR/files/fs_files_backup.json" ]; then
  echo "Importing fs.files..."
  mongoimport --db=$DB_NAME --collection=fs.files --file="$BASE_DIR/files/fs_files_backup.json" --jsonArray --drop
fi

if [ -f "$BASE_DIR/files/fs_chunks_backup.json" ]; then
  echo "Importing fs.chunks..."
  mongoimport --db=$DB_NAME --collection=fs.chunks --file="$BASE_DIR/files/fs_chunks_backup.json" --jsonArray --drop
fi

echo "=== Restarting GenieACS Services ==="
systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
echo "=== Selesai! Silakan refresh Web UI GenieACS dan cek tab Admin ==="
EOF

chmod +x /opt/genieacs/ext/restore_from_git.sh
```

---

### 3. Eksekusi Restore Konfigurasi
```bash
/opt/genieacs/ext/restore_from_git.sh
```

---

### 4. Setup Skrip Backup Automatic (`backup_to_git.sh`) & Cronjob
Buat berkas skrip backup otomatis agar database MongoDB di-export dan di-push berkala ke GitHub:

```bash
cat << 'EOF' > /opt/genieacs/ext/backup_to_git.sh
#!/bin/bash

EXT_DIR="/opt/genieacs/ext"
DB_NAME="genieacs"

# Pastikan direktori tujuan tersedia
mkdir -p "$EXT_DIR/provisions" "$EXT_DIR/presets" "$EXT_DIR/virtual_parameters" \
         "$EXT_DIR/index_fields" "$EXT_DIR/config" "$EXT_DIR/permissions" \
         "$EXT_DIR/users" "$EXT_DIR/files"

cd "$EXT_DIR" || exit

# 1. Export Seluruh Koleksi Database GenieACS
mongoexport --db=$DB_NAME --collection=provisions --out="$EXT_DIR/provisions/provisions_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=presets --out="$EXT_DIR/presets/presets_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=virtualParameters --out="$EXT_DIR/virtual_parameters/vp_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=indexFields --out="$EXT_DIR/index_fields/index_fields_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=config --out="$EXT_DIR/config/config_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=permissions --out="$EXT_DIR/permissions/permissions_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=users --out="$EXT_DIR/users/users_backup.json" --jsonArray --quiet

# Export GridFS (Skrip / Firmware File)
mongoexport --db=$DB_NAME --collection=fs.files --out="$EXT_DIR/files/fs_files_backup.json" --jsonArray --quiet
mongoexport --db=$DB_NAME --collection=fs.chunks --out="$EXT_DIR/files/fs_chunks_backup.json" --jsonArray --quiet

# 2. Sinkronisasi Git & Push ke Remote
git add -A
git pull origin main --rebase --autostash --quiet

if [ -n "$(git status --porcelain)" ]; then
  git add .
  git commit -m "Full backup GenieACS: $(date +'%Y-%m-%d %H:%M:%S')"
  git push origin main
  echo "FULL BACKUP KE GIT SUKSES!"
else
  echo "Tidak ada perubahan data."
fi
EOF

chmod +x /opt/genieacs/ext/backup_to_git.sh
```

Konfigurasikan identitas Git pengunggah:
```bash
git config --global user.email "rsuhaendi@gmail.com"
git config --global user.name "rsuhaendi"
```

Buka editor cron via `crontab -e` dan tambahkan baris berikut agar backup otomatis berjalan setiap tengah malam (00:00):
```cron
0 0 * * * /opt/genieacs/ext/backup_to_git.sh > /dev/null 2>&1
```
