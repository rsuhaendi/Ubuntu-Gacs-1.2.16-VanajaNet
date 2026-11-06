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

# 9. Restore CSS / JS / gambar UI ke public GenieACS
# File backup ada di: $BASE_DIR/ui_custom_backup/public/
UI_SRC="$BASE_DIR/ui_custom_backup/public"
UI_DST="/usr/lib/node_modules/genieacs/public"
if [ -d "$UI_SRC" ]; then
  echo "Restoring UI CSS/JS/gambar..."
  mkdir -p "$UI_DST/img"
  if [ -f "$UI_SRC/app-HGXRD3S7.css" ]; then
    cp -f "$UI_SRC/app-HGXRD3S7.css" "$UI_DST/app-HGXRD3S7.css"
  fi
  if [ -f "$UI_SRC/theme-toggle.js" ]; then
    cp -f "$UI_SRC/theme-toggle.js" "$UI_DST/theme-toggle.js"
  fi
  if [ -d "$UI_SRC/img" ]; then
    cp -af "$UI_SRC/img/." "$UI_DST/img/"
  fi
fi

echo "=== Restarting GenieACS Services ==="
systemctl restart genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
echo "=== Selesai! Silakan refresh Web UI GenieACS dan cek tab Admin ==="
