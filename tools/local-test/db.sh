#!/bin/bash
# Локальная база для проверки: ./db.sh ИМЯ_БАЗЫ миграция1.sql миграция2.sql …
# Запускает Postgres (если ещё не запущен), создаёт базу заново: заглушки (stub.sql) + перечисленные миграции.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=/usr/lib/postgresql/16/bin
DATA=/tmp/pgdata
if ! pg_isready -h /tmp -p 5433 -q 2>/dev/null; then
  if [ ! -d "$DATA/base" ]; then
    rm -rf "$DATA"; mkdir -p "$DATA"; chown postgres "$DATA"
    su postgres -s /bin/bash -c "$BIN/initdb -D $DATA -U postgres -A trust >/dev/null"
  fi
  su postgres -s /bin/bash -c "$BIN/pg_ctl -D $DATA -o '-p 5433 -k /tmp' -l $DATA/pg.log start >/dev/null"
  sleep 2
fi
DB=$1; shift
P="psql -h /tmp -p 5433 -U postgres -q"
$P -c "drop database if exists $DB" >/dev/null 2>&1
$P -c "create database $DB"
$P -d $DB -v ON_ERROR_STOP=1 -f "$HERE/stub.sql" >/dev/null
for f in "$@"; do $P -d $DB -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
echo "база $DB готова: $(psql -h /tmp -p 5433 -U postgres -d $DB -qAt -c 'select count(*) from public.profiles') участников"
