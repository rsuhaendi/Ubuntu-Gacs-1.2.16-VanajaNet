#!/bin/bash

EXT_DIR="/opt/genieacs/ext"
DB_NAME="genieacs"

# Pastikan direktori tujuan tersedia
mkdir -p "$EXT_DIR/provisions" "$EXT_DIR/presets" "$EXT_DIR/virtual_parameters" \
         "$EXT_DIR/index_fields" "$EXT_DIR/config" "$EXT_DIR/permissions" \
         "$EXT_DIR/users" "$EXT_DIR/files" \
         "$EXT_DIR/ui_custom_backup/public" "$EXT_DIR/ui_custom_backup/public/img"

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

# 1b. Backup CSS / JS / gambar UI yang sudah diedit langsung di public
# File aktif di: /usr/lib/node_modules/genieacs/public/ (di luar repo git)
UI_PUBLIC="/usr/lib/node_modules/genieacs/public"
if [ -f "$UI_PUBLIC/app-HGXRD3S7.css" ]; then
  cp -f "$UI_PUBLIC/app-HGXRD3S7.css" "$EXT_DIR/ui_custom_backup/public/app-HGXRD3S7.css"
fi
if [ -f "$UI_PUBLIC/theme-toggle.js" ]; then
  cp -f "$UI_PUBLIC/theme-toggle.js" "$EXT_DIR/ui_custom_backup/public/theme-toggle.js"
fi
if [ -d "$UI_PUBLIC/img" ]; then
  cp -af "$UI_PUBLIC/img/." "$EXT_DIR/ui_custom_backup/public/img/"
fi

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
