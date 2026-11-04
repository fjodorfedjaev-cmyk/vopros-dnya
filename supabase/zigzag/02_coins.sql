-- «ЗИГЗАГ», часть 2: вместо кристаллов на дорожке лежат монеты. Каждая собранная — 1 монета сайта.
-- Числа должны совпадать с CONFIG в zigzag.js: первая монета не раньше плитки №8,
-- дальше не ближе 25 плиток друг к другу (coinFrom, coinGap).
-- Старые партии (с кристаллами) остаются как были: в них coins — сколько монет начислено.

drop function public.zz_finish(uuid, integer, integer, integer);
drop function public.zz_max_crystals(integer);
drop function public.zz_leaderboard(text);

comment on column public.zigzag_sessions.crystals is 'Только у старых партий (до 04.11.2026), когда монеты давались за кристаллы';
comment on column public.zigzag_sessions.coins is 'Сколько монет начислено за партию';

-- Больше этого монет на таком пути быть не может.
create function public.zz_max_coins(p_tiles integer)
returns integer
language sql immutable set search_path = ''
as $$
  select case when coalesce(p_tiles, 0) < 8 then 0 else (p_tiles - 8) / 25 + 1 end
$$;

create function public.zz_finish(p_session uuid, p_score integer, p_tiles integer, p_coins integer)
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
  ok := p_score is not null and p_tiles is not null and p_coins is not null
        and p_tiles between 0 and 100000
        and p_score between 0 and p_tiles
        and p_coins between 0 and public.zz_max_coins(p_tiles)
        and dur >= public.zz_min_ms(p_tiles, p_score) * 0.9
        and dur <= 6 * 3600 * 1000;
  if ok then c := p_coins; end if;

  update public.zigzag_sessions z
     set finished_at = now(), score = greatest(coalesce(p_score, 0), 0), tiles = greatest(coalesce(p_tiles, 0), 0),
         crystals = null, coins = c, duration_ms = least(dur, 2147483647)::integer, valid = ok
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

-- Рейтинг: лучшая партия каждого за неделю или за всё время; coins — монеты в этой партии.
create function public.zz_leaderboard(p_period text default 'week')
returns table (rank bigint, user_id uuid, display_name text, color text, avatar text, best integer, coins integer)
language sql stable security definer set search_path = ''
as $$
  with best as (
    select distinct on (z.user_id) z.user_id, z.score, z.coins, z.finished_at
    from public.zigzag_sessions z
    where z.valid
      and (coalesce(p_period, 'week') = 'all' or z.finished_at >= public.game_week_start())
    order by z.user_id, z.score desc, z.finished_at asc
  )
  select rank() over (order by b.score desc), b.user_id, p.display_name, p.color, p.avatar, b.score, coalesce(b.coins, 0)
  from best b join public.profiles p on p.id = b.user_id
  where public.is_member()
  order by b.score desc, b.finished_at asc
$$;

revoke all on function public.zz_max_coins(integer) from public, anon, authenticated;
revoke all on function public.zz_finish(uuid, integer, integer, integer) from public, anon;
revoke all on function public.zz_leaderboard(text) from public, anon;
grant execute on function public.zz_finish(uuid, integer, integer, integer) to authenticated;
grant execute on function public.zz_leaderboard(text) to authenticated;
