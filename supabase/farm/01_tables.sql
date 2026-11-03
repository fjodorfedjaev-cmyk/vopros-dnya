-- ФЕРМА, часть 1: таблицы и настройки экономики.
-- Серебро — отдельная валюта фермы. Монеты (points_ledger, casino_rounds) не затрагиваются.
-- Ничего существующего не меняем: только создаём новое.

-- 1. Семена: единственное место, где записаны цены, сроки и выплаты.
--    Цену можно поменять обычным UPDATE; уже посаженный урожай своих условий не теряет.
create table public.farm_seeds (
  id           text primary key,
  name         text    not null,
  grow_seconds integer not null check (grow_seconds > 0),
  cost         integer not null check (cost >= 0),          -- сколько списывается при посадке
  payout       integer not null check (payout >= cost),     -- сколько начисляется при сборе (вся выплата)
  sort         integer not null,
  active       boolean not null default true
);

-- 2. Цены клеток. Номера 1..16 — те же, что видит игрок.
create table public.farm_plot_prices (
  plot  integer primary key check (plot between 1 and 16),
  price integer not null check (price >= 0)
);

-- 3. Кошелёк фермы: серебро и число открытых клеток. Одна строка на игрока.
create table public.farm_wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  silver     integer not null default 100 check (silver >= 0),   -- 100 = стартовое серебро нового игрока
  plots_open integer not null default 2 check (plots_open between 2 and 16),
  created_at timestamptz not null default now()
);

-- 4. Посадки. Одна строка = один цикл (посадка → сбор).
--    Цена, выплата и время готовности записываются в момент посадки и больше не меняются.
create table public.farm_plantings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  plot         integer not null check (plot between 1 and 16),
  seed_id      text not null references public.farm_seeds (id),
  planted_at   timestamptz not null,
  ready_at     timestamptz not null,
  cost         integer not null check (cost >= 0),
  payout       integer not null check (payout >= cost),
  harvested_at timestamptz
);

-- На одной клетке не может быть двух невыбранных посадок одновременно.
create unique index farm_one_active_per_plot
  on public.farm_plantings (user_id, plot) where harvested_at is null;

-- 5. Журнал серебра: что и когда списалось или начислилось (для истории и проверки).
create table public.farm_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('start', 'buy_plot', 'plant', 'harvest')),
  amount     integer not null,          -- + начислено, − списано
  ref        text,                      -- номер клетки или id посадки
  created_at timestamptz not null default now()
);
create index farm_log_user_idx on public.farm_log (user_id, created_at desc);

-- Защита: как у таблиц с деньгами — доступ только через функции базы.
alter table public.farm_seeds        enable row level security;
alter table public.farm_plot_prices  enable row level security;
alter table public.farm_wallets      enable row level security;
alter table public.farm_plantings    enable row level security;
alter table public.farm_log          enable row level security;

revoke all on public.farm_seeds, public.farm_plot_prices, public.farm_wallets,
              public.farm_plantings, public.farm_log from anon, authenticated;

-- Стартовые настройки экономики (первая версия, подлежит проверке в тесте).
insert into public.farm_seeds (id, name, grow_seconds, cost, payout, sort) values
  ('cress',      'Кресс-салат',     30,     0,    1, 1),
  ('radish',     'Редис',           120,    20,   23, 2),
  ('carrot',     'Морковь',         600,    50,   63, 3),
  ('tomato',     'Помидоры',        1800,   100, 135, 4),
  ('strawberry', 'Клубника',        7200,   250, 370, 5),
  ('pumpkin',    'Тыква',           28800,  600, 1040, 6),
  ('melon',      'Арбуз',           86400,  1200, 2400, 7);

insert into public.farm_plot_prices (plot, price) values
  (1, 0), (2, 0), (3, 600), (4, 800), (5, 1000), (6, 1300), (7, 1700), (8, 2200),
  (9, 2900), (10, 3700), (11, 4800), (12, 6300), (13, 8200), (14, 10700), (15, 13900), (16, 18000);
