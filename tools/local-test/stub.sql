-- Заглушки рабочей базы для локальной проверки: только то, на что опираются миграции и сайт.
-- Это НЕ копия базы: здесь нет ни данных, ни кода приглашения. Имена и монеты — выдуманные.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to authenticated;
-- auth.uid() читает того же «вошедшего», что и Supabase: request.jwt.claims → sub
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json->>'sub', '')::uuid $$;

create table public.profiles (id uuid primary key, display_name text, color text, created_at timestamptz default now(), avatar text, zodiac text);
create function public.is_member() returns boolean language sql stable security definer set search_path to 'public'
  as $$ select exists (select 1 from public.profiles where id = auth.uid()) $$;
create table public.admins (user_id uuid primary key references public.profiles (id));
create function public.is_admin() returns boolean language sql stable security definer set search_path to ''
  as $$ select exists (select 1 from public.admins a where a.user_id = auth.uid()) $$;
grant execute on function public.is_admin() to authenticated;
create function public.today_tallinn() returns date language sql stable as $$ select (now() at time zone 'Europe/Tallinn')::date $$;

-- монеты: книга + казино + лавка (как в рабочей базе до «Дурака»; миграции «Дурака» заменяют coins_of)
create table public.points_ledger (id bigint generated always as identity primary key, user_id uuid not null references public.profiles (id),
  amount integer not null, reason text not null, ref text, day date default public.today_tallinn(), created_at timestamptz default now(),
  unique (user_id, reason, ref));
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question','fill','streak','game','poll','suggest','cards','duel']));
create table public.casino_rounds (id bigint generated always as identity primary key, user_id uuid, bet numeric, payout numeric);
create table public.card_listings (id bigint generated always as identity primary key, seller_id uuid, buyer_id uuid, price numeric, fee numeric, status text);
create function public.coins_of(p_user uuid) returns numeric language sql stable security definer set search_path to '' as $$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0), 2) $$;
create function public.my_points() returns table (balance numeric, today integer, game_today integer, game_cap integer)
  language sql stable security definer set search_path to '' as $$ select public.coins_of(auth.uid()), 0, 0, 0 where public.is_member() $$;
create function public.member_coins() returns table (user_id uuid, coins numeric)
  language sql stable security definer set search_path to '' as $$ select p.id, public.coins_of(p.id) from public.profiles p where public.is_member() $$;
grant execute on function public.my_points() to authenticated;
grant execute on function public.member_coins() to authenticated;

-- уведомления: вместо отправки — запись в push_calls (видно, что ушло бы)
create table public.push_subscriptions (endpoint text primary key, user_id uuid, p256dh text, auth text, active boolean default true, created_at timestamptz default now(), updated_at timestamptz);
create table public.push_calls (payload jsonb, at timestamptz default clock_timestamp());
-- как на рабочей базе: push_call (её копия ниже) → net.http_post, который здесь только записывает запрос
-- в очередь net.http_request_queue (как pg_net) и в push_calls
create schema if not exists net;
create table net.http_request_queue (id bigserial primary key, method text default 'POST', url text, headers jsonb, body bytea, timeout_milliseconds integer);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
  returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into net.http_request_queue (url, headers, body, timeout_milliseconds) values (url, headers, convert_to(body::text, 'utf8'), timeout_milliseconds) returning id into v;
  insert into public.push_calls (payload) values (body);
  return v;
end $$;
create function public.push_hook_secret() returns text language sql as $$ select 'local-secret' $$;
-- push_call — как была на рабочей базе до 21.11 (supabase/push/01_no_card_games.sql добавляет в неё запрет для карточных игр)
create function public.push_call(p_payload jsonb) returns void language plpgsql security definer set search_path to ''
as $function$
declare s text := public.push_hook_secret();
begin
  if s is null then return; end if;
  perform net.http_post(
    url := 'https://zbjhayjnxlvmpzxpiktg.supabase.co/functions/v1/push',
    body := p_payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', s),
    timeout_milliseconds := 10000
  );
end $function$;

-- шесть выдуманных участников (первый — админ), у каждого 1000 монет и подписка на уведомления
insert into public.profiles (id, display_name, color, created_at)
select gen_random_uuid(), (array['Федя','Аня','Никита','Соня','Настя','Тая'])[i],
       (array['#F2782C','#4C95F5','#3FB97F','#9B7BFF','#F5B04A','#E8364F'])[i], now() - (10 - i) * interval '1 day'
from generate_series(1, 6) i;
insert into public.admins (user_id) select id from public.profiles order by created_at limit 1;
insert into public.points_ledger (user_id, amount, reason, ref) select id, 1000, 'game', 'start' from public.profiles;
insert into public.push_subscriptions (endpoint, user_id) select 'e' || id, id from public.profiles;
