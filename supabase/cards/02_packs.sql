-- КОЛЛЕКЦИОННЫЕ КАРТОЧКИ: ПАКИ — подарок, когда колода серии закончилась.
--
-- Как устроено (простыми словами):
-- * Колода «Начала» опустела (разошлись все 85) — серия закрывается. В этот момент база считает подарки:
--   сколько карточек человек открыл из колоды (только покупки из колоды, не Лавка; проданные и переплавленные тоже
--   считаются) — столько паков, но не больше 3.
-- * Подарок забирают нажатием «Забрать» — паки появляются в коллекции.
-- * Пак — это тоже вещь в коллекции: отдельная «карточка» серии с редкостью 'pack'. Поэтому Лавка (лоты, заявки,
--   история, уведомления) работает с паками сама, без отдельного кода. Номер у пака — порядковый (№3 из всех выданных).
-- * Пак нельзя поставить на витрину и переплавить — только открыть или продать.
-- * Открыть пак: база как будто перемешивает все 85 исходных копий полной колоды и вытягивает одну. Поэтому шанс
--   карточки — как её доля в колоде: обычная (6 копий) — 6 из 85, «Солнце дня» — 1 из 85.
--   Карточка из пака — новая копия сверх тиража: у «Монеты» было №1–№6, из пака будет №7/6, потом №8/6 и так далее.
--   Что выпадет, база решает в момент открытия (заранее нигде не записано — подсмотреть нельзя).
-- * Карточка из пака — обычная копия: витрина, Лавка, переплавка по тем же правилам.
-- * Очередь 'cards:pack:<серия>' — открытия и выдача паков идут по одному, чтобы двое не получили один номер.

-- 1. Новые редкость, состояние и записи истории
alter table public.cards drop constraint cards_rarity_check;
alter table public.cards add constraint cards_rarity_check
  check (rarity = any (array['common', 'uncommon', 'rare', 'epic', 'legendary', 'pack']));

alter table public.card_copies drop constraint card_copies_state_check;
alter table public.card_copies add constraint card_copies_state_check
  check (state = any (array['deck', 'owned', 'market', 'melted', 'opened']));   -- opened — пак открыт

alter table public.card_events drop constraint card_events_kind_check;
alter table public.card_events add constraint card_events_kind_check
  check (kind = any (array['open', 'melt', 'gift', 'sale', 'list', 'reprice', 'unlist',
                           'grant',     -- пак выдан в подарок
                           'unpack',    -- пак открыт
                           'pack']));   -- карточка вышла из пака

-- 2. Когда серия закрылась (колода опустела) и подарки
alter table public.card_series add column closed_at timestamptz;

create table public.card_pack_gifts (
  series_id smallint not null references public.card_series (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  packs smallint not null check (packs between 1 and 3),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,                    -- когда нажал «Забрать»
  primary key (series_id, user_id)
);
alter table public.card_pack_gifts enable row level security;
revoke all on public.card_pack_gifts from anon, authenticated;

-- 3. Пак серии «Начало». copies — сколько паков выдано всего (станет известно, когда колода опустеет).
insert into public.cards (series_id, code, name, rarity, copies, sort) values (1, 'pack', 'Пак', 'pack', 1, 21);

-- 4. Закрыть серию: колода пуста — записываем подарки (1 открытая карточка — 1 пак, не больше 3).
--    Можно звать сколько угодно раз: закрывается только однажды.
create or replace function public.cards_close_series(p_series integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  total integer;
begin
  perform pg_advisory_xact_lock(hashtext('cards:deck:' || p_series::text));
  if exists (select 1 from public.card_series s where s.id = p_series and s.closed_at is not null) then return; end if;
  if exists (select 1 from public.card_copies k join public.cards c on c.id = k.card_id
              where c.series_id = p_series and k.state = 'deck') then return; end if;
  update public.card_series s set closed_at = now() where s.id = p_series;
  insert into public.card_pack_gifts (series_id, user_id, packs)
    select p_series, e.to_user, least(count(*), 3)
    from public.card_events e
    join public.card_copies k on k.id = e.copy_id
    join public.cards c on c.id = k.card_id
    where e.kind = 'open' and c.series_id = p_series and e.to_user is not null
    group by e.to_user;
  select coalesce(sum(g.packs), 0) into total from public.card_pack_gifts g where g.series_id = p_series;
  update public.cards c set copies = greatest(1, total) where c.series_id = p_series and c.rarity = 'pack';
end $function$;
revoke all on function public.cards_close_series(integer) from public, anon, authenticated;

-- 5. Открыть карточку из колоды — как раньше, плюс: взяли последнюю — серия закрывается, подарки записаны.
create or replace function public.cards_open(p_series integer, p_price integer)
returns table (copy_id bigint, card_id integer, code text, name text, rarity text, serial integer, copies integer,
               balance numeric, next_price integer, deck_left integer)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  cur integer;
  cid bigint;
  left_n integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('cards:deck:' || p_series::text));
  cur := public.cards_price(p_series);
  if cur is null then raise exception 'cards_deck_empty'; end if;
  if p_price is distinct from cur then raise exception 'cards_price_changed'; end if;
  if public.coins_of(uid) < cur then raise exception 'cards_not_enough'; end if;

  select k.id into cid
  from public.card_copies k join public.cards c on c.id = k.card_id
  where c.series_id = p_series and k.state = 'deck'
  order by random()
  limit 1;

  update public.card_copies k set state = 'owned', owner_id = uid, obtained_at = now() where k.id = cid;
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -cur, 'cards', 'open:' || cid);
  insert into public.card_events (copy_id, kind, to_user, price) values (cid, 'open', uid, cur);

  select count(*)::integer into left_n from public.card_copies x join public.cards y on y.id = x.card_id
   where y.series_id = p_series and x.state = 'deck';
  if left_n = 0 then perform public.cards_close_series(p_series); end if;

  return query
    select k.id, c.id, c.code, c.name, c.rarity, k.serial::integer, c.copies::integer,
           public.coins_of(uid), public.cards_price(p_series), left_n
    from public.card_copies k join public.cards c on c.id = k.card_id
    where k.id = cid;
end $function$;
revoke all on function public.cards_open(integer, integer) from public, anon;
grant execute on function public.cards_open(integer, integer) to authenticated;

-- 6. Колода: «Осталось X из 85» — считаем только исходные копии (без паков и без копий из паков)
create or replace function public.cards_deck(p_series integer default 1)
returns table (series_name text, price integer, deck_left integer, deck_total integer,
               left_common integer, left_uncommon integer, left_rare integer, left_epic integer, left_legendary integer)
language sql stable security definer set search_path to ''
as $function$
  select s.name, public.cards_price(s.id),
    count(*) filter (where k.state = 'deck')::integer,
    count(*) filter (where k.serial <= c.copies)::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'common')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'uncommon')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'rare')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'epic')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'legendary')::integer
  from public.card_series s
  join public.cards c on c.series_id = s.id
  join public.card_copies k on k.card_id = c.id
  where s.id = p_series and c.rarity <> 'pack' and public.is_member()
  group by s.id, s.name
$function$;

-- 7. Мой подарок: сколько паков ждёт («Забрать»). Пусто — подарка нет или уже забран.
create or replace function public.cards_pack_gift()
returns table (series_id integer, series_name text, packs integer)
language sql stable security definer set search_path to ''
as $function$
  select g.series_id::integer, s.name, g.packs::integer
  from public.card_pack_gifts g join public.card_series s on s.id = g.series_id
  where g.user_id = auth.uid() and g.claimed_at is null and public.is_member()
  order by g.series_id
$function$;
revoke all on function public.cards_pack_gift() from public, anon;
grant execute on function public.cards_pack_gift() to authenticated;

-- 8. Забрать подарок: паки появляются в коллекции. Второй раз — 0 (ничего не добавится).
create or replace function public.cards_pack_claim(p_series integer)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.card_pack_gifts%rowtype;
  pid integer;
  base integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('cards:pack:' || p_series::text));
  select * into g from public.card_pack_gifts x where x.series_id = p_series and x.user_id = uid for update;
  if not found or g.claimed_at is not null then return 0; end if;
  select c.id into pid from public.cards c where c.series_id = p_series and c.rarity = 'pack';
  select coalesce(max(k.serial), 0) into base from public.card_copies k where k.card_id = pid;
  with made as (
    insert into public.card_copies (card_id, serial, state, owner_id, obtained_at)
      select pid, base + s, 'owned', uid, now() from generate_series(1, g.packs) s
      returning id
  )
  insert into public.card_events (copy_id, kind, to_user) select m.id, 'grant', uid from made m;
  update public.card_pack_gifts x set claimed_at = now() where x.series_id = p_series and x.user_id = uid;
  return g.packs;
end $function$;
revoke all on function public.cards_pack_claim(integer) from public, anon;
grant execute on function public.cards_pack_claim(integer) to authenticated;

-- 9. Открыть пак: случайная карточка серии с шансами полной колоды, новая копия сверх тиража.
create or replace function public.cards_pack_open(p_copy bigint)
returns table (copy_id bigint, card_id integer, code text, name text, rarity text, serial integer, copies integer, packs_left integer)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  k public.card_copies%rowtype;
  sid smallint;
  cid integer;
  ns integer;
  nid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select c.series_id into sid from public.card_copies x join public.cards c on c.id = x.card_id
   where x.id = p_copy and c.rarity = 'pack';
  if not found then raise exception 'cards_not_pack'; end if;
  perform pg_advisory_xact_lock(hashtext('cards:pack:' || sid::text));
  select * into k from public.card_copies x where x.id = p_copy for update;
  if k.owner_id is distinct from uid or k.state <> 'owned' then raise exception 'cards_not_yours'; end if;

  -- одна из 85 исходных копий (где бы она сейчас ни была) — от неё берём только, какая это карточка
  select x.card_id into cid
  from public.card_copies x join public.cards c on c.id = x.card_id
  where c.series_id = sid and c.rarity <> 'pack' and x.serial <= c.copies
  order by random()
  limit 1;
  select max(x.serial) + 1 into ns from public.card_copies x where x.card_id = cid;

  insert into public.card_copies (card_id, serial, state, owner_id, obtained_at)
    values (cid, ns, 'owned', uid, now()) returning id into nid;
  update public.card_copies x set state = 'opened' where x.id = p_copy;
  insert into public.card_events (copy_id, kind, from_user) values (p_copy, 'unpack', uid);
  insert into public.card_events (copy_id, kind, to_user) values (nid, 'pack', uid);

  return query
    select nid, c.id, c.code, c.name, c.rarity, ns, c.copies::integer,
           (select count(*)::integer from public.card_copies x join public.cards y on y.id = x.card_id
             where x.owner_id = uid and x.state = 'owned' and y.rarity = 'pack')
    from public.cards c where c.id = cid;
end $function$;
revoke all on function public.cards_pack_open(bigint) from public, anon;
grant execute on function public.cards_pack_open(bigint) to authenticated;

-- 10. Витрина: пак поставить нельзя
create or replace function public.cards_set_showcase(p_slot integer, p_copy bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if p_slot is null or p_slot not between 1 and 3 then raise exception 'cards_bad_slot'; end if;
  if p_copy is not null and not exists (select 1 from public.card_copies x where x.id = p_copy and x.owner_id = uid and x.state = 'owned') then
    raise exception 'cards_not_yours';
  end if;
  if p_copy is not null and exists (select 1 from public.card_copies x join public.cards c on c.id = x.card_id
                                     where x.id = p_copy and c.rarity = 'pack') then
    raise exception 'cards_pack_shelf';
  end if;
  delete from public.card_showcase sc where sc.user_id = uid and (sc.slot = p_slot or sc.copy_id = p_copy);
  if p_copy is not null then
    insert into public.card_showcase (user_id, slot, copy_id) values (uid, p_slot, p_copy);
  end if;
end $function$;

-- 11. «Собрано X из 20» — паки не считаются
create or replace function public.cards_members()
returns table (user_id uuid, distinct_cards integer, total_copies integer)
language sql stable security definer set search_path to ''
as $function$
  select k.owner_id, count(distinct k.card_id)::integer, count(*)::integer
  from public.card_copies k join public.cards c on c.id = k.card_id
  where k.state = 'owned' and k.owner_id is not null and c.rarity <> 'pack' and public.is_member()
  group by k.owner_id
$function$;

create or replace function public.member_profile(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid();
  p public.profiles%rowtype;
  st record;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into p from public.profiles x where x.id = p_user;
  if not found then return null; end if;
  select s.current_streak, s.best_streak, s.total_answers, s.answered_today, s.reactions_received
    into st from public.member_stats() s where s.user_id = p_user;
  return jsonb_build_object(
    'user_id', p.id, 'name', p.display_name, 'color', p.color, 'avatar', p.avatar, 'zodiac', p.zodiac, 'joined', p.created_at,
    'streak', coalesce(st.current_streak, 0), 'best_streak', coalesce(st.best_streak, 0),
    'answers', coalesce(st.total_answers, 0), 'answered_today', coalesce(st.answered_today, false),
    'reactions', coalesce(st.reactions_received, 0),
    'coins', public.coins_of(p_user),
    'cards', (select count(distinct k.card_id)::integer from public.card_copies k join public.cards c on c.id = k.card_id
               where k.owner_id = p_user and k.state = 'owned' and c.rarity <> 'pack'),
    'cards_total', (select count(*)::integer from public.cards c where c.rarity <> 'pack'),
    'shelf', coalesce((
      select jsonb_agg(jsonb_build_object('card_id', c.id, 'code', c.code, 'name', c.name, 'rarity', c.rarity,
                                          'copies', c.copies, 'serial', k.serial) order by sc.slot)
      from public.card_showcase sc
      join public.card_copies k on k.id = sc.copy_id
      join public.cards c on c.id = k.card_id
      where sc.user_id = p_user), '[]'::jsonb),
    'sector_best', (select max(g.score) from public.game_sessions g where g.user_id = p_user and g.game = 'sector' and g.valid),
    'zigzag_best', (select max(z.score) from public.zigzag_sessions z where z.user_id = p_user and z.valid),
    'duels', (
      select jsonb_build_object(
        'won', count(*) filter (where (d.result = 'p1' and d.p1 = p_user) or (d.result = 'p2' and d.p2 = p_user)),
        'lost', count(*) filter (where (d.result = 'p2' and d.p1 = p_user) or (d.result = 'p1' and d.p2 = p_user)),
        'draw', count(*) filter (where d.result = 'draw'))
      from public.sector_duels d
      where d.status = 'finished' and (d.p1 = p_user or d.p2 = p_user)),
    'vs', case when me is null or me = p_user then null else (
      select jsonb_build_object(
        'me', count(*) filter (where (d.result = 'p1' and d.p1 = me) or (d.result = 'p2' and d.p2 = me)),
        'them', count(*) filter (where (d.result = 'p1' and d.p1 = p_user) or (d.result = 'p2' and d.p2 = p_user)),
        'draw', count(*) filter (where d.result = 'draw'))
      from public.sector_duels d
      where d.status = 'finished' and ((d.p1 = me and d.p2 = p_user) or (d.p1 = p_user and d.p2 = me))) end,
    'durak', (
      select jsonb_build_object('games', count(*), 'first', count(*) filter (where dp.place = 1))
      from public.durak_players dp
      join public.durak_rooms r on r.id = dp.room_id
      where dp.user_id = p_user and r.status = 'finished' and not r.test)
  );
end $function$;

-- 12. Уведомления о продаже: у копии сверх тиража «Солнца дня» (№2/1) — номер, а не «1/1»
create or replace function public.push_sale_info(p_listing bigint)
returns table (seller uuid, card_name text, serial integer, copies integer, net numeric, buyer_name text)
language sql stable security definer set search_path to ''
as $function$
  select l.seller_id, c.name, k.serial::integer, case when k.serial > c.copies then 0 else c.copies::integer end,
         l.price - l.fee, coalesce(p.display_name, 'Кто-то')
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  join public.cards c on c.id = k.card_id
  left join public.profiles p on p.id = l.buyer_id
  where l.id = p_listing and l.status = 'sold'
$function$;

create or replace function public.push_bid_info(p_listing bigint)
returns table (buyer uuid, card_name text, serial integer, copies integer, price numeric, seller_name text)
language sql stable security definer set search_path to ''
as $function$
  select l.buyer_id, c.name, k.serial::integer, case when k.serial > c.copies then 0 else c.copies::integer end,
         l.price, coalesce(p.display_name, 'Кто-то')
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  join public.cards c on c.id = k.card_id
  left join public.profiles p on p.id = l.seller_id
  where l.id = p_listing and l.status = 'sold'
$function$;

-- 13. Если колода уже пуста к моменту этой миграции — закрыть серию сразу (иначе ничего не делает)
select public.cards_close_series(1);
