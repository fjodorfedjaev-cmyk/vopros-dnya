-- «ЗИГЗАГ»: партии, проверка результата, монеты за кристаллы, рейтинг.
-- Устроено как у «Сектора», но в своей таблице, чтобы рейтинги не смешивались.
-- Числа проверки должны совпадать с CONFIG в zigzag.js:
--   скорость 2,2 плитки/с + 0,07 за очко, не больше 6,2;
--   кристаллы с 5-й плитки (номер 4), не ближе 5 плиток друг к другу;
--   5 кристаллов = 1 монета (по итогам партии, с округлением вниз).

create table public.zigzag_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  score       integer check (score >= 0),       -- удачные повороты
  tiles       integer check (tiles >= 0),       -- до какой плитки доехал
  crystals    integer check (crystals >= 0),
  coins       integer check (coins >= 0),       -- сколько монет начислено
  duration_ms integer,
  valid       boolean
);
create index zigzag_sessions_user_idx on public.zigzag_sessions (user_id);
create index zigzag_sessions_finished_idx on public.zigzag_sessions (finished_at);
alter table public.zigzag_sessions enable row level security;
revoke all on public.zigzag_sessions from anon, authenticated;

-- Быстрее этого проехать столько плиток нельзя: шарик никогда не быстрее скорости при итоговом счёте.
create function public.zz_min_ms(p_tiles integer, p_score integer)
returns numeric
language sql immutable set search_path = ''
as $$
  select greatest(coalesce(p_tiles, 0) - 1, 0) * 1000.0
         / least(6.2, 2.2 + greatest(coalesce(p_score, 0), 0) * 0.07)
$$;

-- Больше этого кристаллов на таком пути быть не может.
create function public.zz_max_crystals(p_tiles integer)
returns integer
language sql immutable set search_path = ''
as $$
  select case when coalesce(p_tiles, 0) < 4 then 0 else (p_tiles - 4) / 5 + 1 end
$$;

-- Начало партии: сервер запоминает время старта.
create function public.zz_start()
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare sid uuid;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  insert into public.zigzag_sessions (user_id) values (auth.uid()) returning id into sid;
  return sid;
end $$;

-- Конец партии: проверка, монеты за кристаллы, рекорды.
create function public.zz_finish(p_session uuid, p_score integer, p_tiles integer, p_crystals integer)
returns table (valid boolean, coins integer, best_all integer, best_week integer, prev_best integer)
language plpgsql security definer set search_path = ''
as $$
declare
  s public.zigzag_sessions;
  dur numeric;
  ok boolean;
  prev integer;
  c integer := 0;
begin
  select * into s from public.zigzag_sessions z where z.id = p_session and z.user_id = auth.uid() for update;
  if not found then raise exception 'bad_session'; end if;
  if s.finished_at is not null then raise exception 'already_finished'; end if;

  select max(z.score) into prev from public.zigzag_sessions z where z.user_id = auth.uid() and z.valid;

  dur := extract(epoch from (clock_timestamp() - s.started_at)) * 1000;
  ok := p_score is not null and p_tiles is not null and p_crystals is not null
        and p_tiles between 0 and 100000
        and p_score between 0 and p_tiles
        and p_crystals between 0 and public.zz_max_crystals(p_tiles)
        and dur >= public.zz_min_ms(p_tiles, p_score) * 0.9
        and dur <= 6 * 3600 * 1000;
  if ok then c := p_crystals / 5; end if;

  update public.zigzag_sessions z
     set finished_at = now(), score = greatest(coalesce(p_score, 0), 0), tiles = greatest(coalesce(p_tiles, 0), 0),
         crystals = greatest(coalesce(p_crystals, 0), 0), coins = c, duration_ms = least(dur, 2147483647)::integer, valid = ok
   where z.id = p_session;

  -- монеты — в общий журнал сайта, как за «Сектор»; повторно за ту же партию не начислятся
  if ok and c > 0 then
    insert into public.points_ledger (user_id, amount, reason, ref)
    values (auth.uid(), c, 'game', 'zigzag:' || p_session::text)
    on conflict do nothing;
  end if;

  return query
    select ok, c,
      (select max(z.score) from public.zigzag_sessions z where z.user_id = auth.uid() and z.valid),
      (select max(z.score) from public.zigzag_sessions z where z.user_id = auth.uid() and z.valid
         and z.finished_at >= public.game_week_start()),
      prev;
end $$;

-- Рейтинг: лучшая партия каждого за неделю или за всё время.
create function public.zz_leaderboard(p_period text default 'week')
returns table (rank bigint, user_id uuid, display_name text, color text, avatar text, best integer, crystals integer)
language sql stable security definer set search_path = ''
as $$
  with best as (
    select distinct on (z.user_id) z.user_id, z.score, z.crystals, z.finished_at
    from public.zigzag_sessions z
    where z.valid
      and (coalesce(p_period, 'week') = 'all' or z.finished_at >= public.game_week_start())
    order by z.user_id, z.score desc, z.finished_at asc
  )
  select rank() over (order by b.score desc), b.user_id, p.display_name, p.color, p.avatar, b.score, b.crystals
  from best b join public.profiles p on p.id = b.user_id
  where public.is_member()
  order by b.score desc, b.finished_at asc
$$;

revoke all on function public.zz_min_ms(integer, integer) from public, anon, authenticated;
revoke all on function public.zz_max_crystals(integer) from public, anon, authenticated;
revoke all on function public.zz_start() from public, anon;
revoke all on function public.zz_finish(uuid, integer, integer, integer) from public, anon;
revoke all on function public.zz_leaderboard(text) from public, anon;
grant execute on function public.zz_start() to authenticated;
grant execute on function public.zz_finish(uuid, integer, integer, integer) to authenticated;
grant execute on function public.zz_leaderboard(text) to authenticated;
