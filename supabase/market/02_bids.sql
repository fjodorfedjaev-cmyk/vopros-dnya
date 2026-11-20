-- ЛАВКА, этап 2: ЗАЯВКИ НА ПОКУПКУ («Рынок / Продать / Мои сделки»)
--
-- Как устроено (простыми словами):
-- * Заявка: «куплю любую копию карточки X по цене не выше P». Одна заявка — одна карточка.
--   Монеты на заявку откладываются сразу: баланс (coins_of) меньше на P, пока заявка висит.
--   Поэтому казино, покер, карточки и всё остальное не могут потратить отложенные монеты — они смотрят coins_of.
--   Отменил заявку — монеты снова доступны. Срока у заявки нет. Не больше 20 заявок у одного человека.
-- * Совпадение. Чужие заявка и лот одной карточки не висят одновременно, если заявка не ниже цены лота:
--   - выставил копию (или снизил цену) не дороже лучшей заявки — продано сразу, по цене заявки;
--   - создал заявку (или поднял её) не ниже самой дешёвой цены — куплено сразу, по цене лота.
--   Лучшая заявка — самая дорогая, при равной — та, у которой цену назначили раньше.
--   Лучший лот — самый дешёвый, при равной — так же, кто раньше. Себе свою карточку не продаёшь.
-- * Комиссия 10% (market_fee) — всегда с продавца, при продаже в заявку тоже.
-- * Продажа в заявку записывается как обычная продажа (card_listings, 'sold'), а заявка — 'filled' со ссылкой
--   на эту продажу. Поэтому баланс и история считаются как раньше.
-- * Блокировки всегда в одном порядке, чтобы встречные действия не зависли друг на друге:
--   очередь монет покупателя 'points:<id>' → карточка 'market_card:<id>' → строки (лот, заявка, копия).
-- * Уведомления: продавцу — «Твою карточку купили» (как раньше), покупателю — «Заявка исполнена» (тип 'bid').

-- 1. Заявки. Напрямую таблица закрыта — всё только через функции ниже.
create table public.card_bids (
  id bigint generated always as identity primary key,
  card_id integer not null references public.cards (id),
  buyer_id uuid references auth.users (id) on delete set null,
  price numeric(7, 2) not null check (price between 0.02 and 99999.99),
  status text not null default 'active' check (status in ('active', 'filled', 'cancelled')),
  listing_id bigint references public.card_listings (id),   -- продажа, которой заявка исполнилась
  created_at timestamptz not null default clock_timestamp(),
  placed_at timestamptz not null default clock_timestamp(), -- когда назначили нынешнюю цену (для очереди)
  closed_at timestamptz,
  check (status <> 'filled' or listing_id is not null)
);
create index card_bids_book on public.card_bids (card_id, price desc, placed_at, id) where status = 'active';
create index card_bids_buyer on public.card_bids (buyer_id) where status = 'active';
create unique index card_bids_listing on public.card_bids (listing_id) where listing_id is not null;
alter table public.card_bids enable row level security;
revoke all on public.card_bids from anon, authenticated;

-- 2. Баланс = книга монет + казино + лавка + дурак + покер − отложенное на заявки
create or replace function public.coins_of(p_user uuid)
returns numeric
language sql stable security definer set search_path to ''
as $function$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0)
        + coalesce((select sum(coalesce(d.payout, 0) - d.stake) from public.durak_players d where d.user_id = p_user), 0)
        + coalesce((select sum(coalesce(s.cashout, 0) - s.buyin) from public.poker_seats s where s.user_id = p_user and not s.test), 0)
        - coalesce((select sum(b.price) from public.card_bids b where b.buyer_id = p_user and b.status = 'active'), 0), 2)
$function$;

-- 3. Купить лот (всё уже заблокировано и проверено вызывающей функцией): копия переходит покупателю
create or replace function public.market_take(p_listing bigint, p_buyer uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  l public.card_listings%rowtype;
begin
  select * into l from public.card_listings x where x.id = p_listing;
  update public.card_listings x set status = 'sold', buyer_id = p_buyer, fee = public.market_fee(l.price),
         closed_at = now(), updated_at = now()
   where x.id = l.id;
  update public.card_copies x set state = 'owned', owner_id = p_buyer, obtained_at = now() where x.id = l.copy_id;
  delete from public.card_showcase sc where sc.copy_id = l.copy_id;
  insert into public.card_events (copy_id, kind, from_user, to_user, price) values (l.copy_id, 'sale', l.seller_id, p_buyer, l.price);
  if exists (select 1 from public.push_subscriptions ps where ps.user_id = l.seller_id and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'sale', 'listing_id', l.id));
  end if;
end $function$;
revoke all on function public.market_take(bigint, uuid) from public, anon, authenticated;

-- 4. Продать копию в заявку по цене заявки (всё уже заблокировано). p_listing — лот этой копии, если он есть
--    (тогда он и становится продажей), иначе продажа записывается новой строкой. Возвращает id продажи.
create or replace function public.market_fill(p_bid bigint, p_copy bigint, p_seller uuid, p_listing bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  b public.card_bids%rowtype;
  lid bigint;
begin
  select * into b from public.card_bids x where x.id = p_bid;
  if p_listing is null then
    insert into public.card_listings (copy_id, seller_id, price, status, buyer_id, fee, closed_at)
      values (p_copy, p_seller, b.price, 'sold', b.buyer_id, public.market_fee(b.price), now())
      returning id into lid;
  else
    update public.card_listings x set price = b.price, status = 'sold', buyer_id = b.buyer_id,
           fee = public.market_fee(b.price), closed_at = now(), updated_at = now()
     where x.id = p_listing;
    lid := p_listing;
  end if;
  update public.card_bids x set status = 'filled', listing_id = lid, closed_at = now() where x.id = b.id;
  update public.card_copies x set state = 'owned', owner_id = b.buyer_id, obtained_at = now() where x.id = p_copy;
  delete from public.card_showcase sc where sc.copy_id = p_copy;
  insert into public.card_events (copy_id, kind, from_user, to_user, price) values (p_copy, 'sale', p_seller, b.buyer_id, b.price);
  if exists (select 1 from public.push_subscriptions ps where ps.user_id = b.buyer_id and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'bid', 'listing_id', lid));
  end if;
  return lid;
end $function$;
revoke all on function public.market_fill(bigint, bigint, uuid, bigint) from public, anon, authenticated;

-- 5. Выставить свою копию. Если есть чужая заявка не ниже цены — продано сразу, по цене заявки.
--    p_now = true — «Продать сразу»: только в заявку не ниже p_price; если такой уже нет — ошибка, лот не создаётся.
create or replace function public.market_sell(p_copy bigint, p_price numeric, p_now boolean default false)
returns table (listing_id bigint, sold boolean, price numeric, net numeric, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  k public.card_copies%rowtype;
  b public.card_bids%rowtype;
  cid integer;
  lid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  select x.card_id into cid from public.card_copies x where x.id = p_copy;
  if not found then raise exception 'cards_not_yours'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into k from public.card_copies x where x.id = p_copy for update;
  if k.owner_id is distinct from uid or k.state <> 'owned' then raise exception 'cards_not_yours'; end if;
  if exists (select 1 from public.card_showcase sc where sc.copy_id = p_copy) then raise exception 'cards_in_showcase'; end if;

  select * into b from public.card_bids x
   where x.card_id = cid and x.status = 'active' and x.buyer_id is not null and x.buyer_id <> uid and x.price >= p_price
   order by x.price desc, x.placed_at, x.id limit 1 for update;
  if found then
    lid := public.market_fill(b.id, p_copy, uid, null);
    return query select lid, true, b.price, b.price - public.market_fee(b.price), public.coins_of(uid);
    return;
  end if;
  if p_now then raise exception 'market_bid_gone'; end if;

  update public.card_copies x set state = 'market' where x.id = p_copy;
  insert into public.card_listings (copy_id, seller_id, price, created_at, updated_at)
    values (p_copy, uid, p_price, clock_timestamp(), clock_timestamp()) returning id into lid;
  insert into public.card_events (copy_id, kind, from_user, price) values (p_copy, 'list', uid, p_price);
  return query select lid, false, p_price, p_price - public.market_fee(p_price), public.coins_of(uid);
end $function$;
revoke all on function public.market_sell(bigint, numeric, boolean) from public, anon;
grant execute on function public.market_sell(bigint, numeric, boolean) to authenticated;

-- Старое имя (для сайта, открытого до обновления): то же самое, возвращает номер лота или продажи
create or replace function public.market_list(p_copy bigint, p_price numeric)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  lid bigint;
begin
  select s.listing_id into lid from public.market_sell(p_copy, p_price, false) s;
  return lid;
end $function$;

-- 6. Изменить цену своего лота. Если новая цена не выше чужой заявки — продано сразу, по цене заявки.
create or replace function public.market_reprice(p_listing bigint, p_price numeric)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
  b public.card_bids%rowtype;
  cid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  select k.card_id into cid from public.card_listings x join public.card_copies k on k.id = x.copy_id where x.id = p_listing;
  if not found then raise exception 'market_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into l from public.card_listings x where x.id = p_listing for update;
  if l.seller_id is distinct from uid or l.status <> 'active' then raise exception 'market_gone'; end if;
  if l.price = p_price then return; end if;

  select * into b from public.card_bids x
   where x.card_id = cid and x.status = 'active' and x.buyer_id is not null and x.buyer_id <> uid and x.price >= p_price
   order by x.price desc, x.placed_at, x.id limit 1 for update;
  if found then
    perform public.market_fill(b.id, l.copy_id, uid, l.id);
    return;
  end if;
  update public.card_listings x set price = p_price, updated_at = clock_timestamp() where x.id = l.id;
  insert into public.card_events (copy_id, kind, from_user, price) values (l.copy_id, 'reprice', uid, p_price);
end $function$;

-- 7. Снять с продажи: копия возвращается в коллекцию
create or replace function public.market_cancel(p_listing bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
  cid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select k.card_id into cid from public.card_listings x join public.card_copies k on k.id = x.copy_id where x.id = p_listing;
  if not found then raise exception 'market_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into l from public.card_listings x where x.id = p_listing for update;
  if l.seller_id is distinct from uid or l.status <> 'active' then raise exception 'market_gone'; end if;
  update public.card_listings x set status = 'cancelled', closed_at = now(), updated_at = now() where x.id = l.id;
  update public.card_copies x set state = 'owned' where x.id = l.copy_id and x.state = 'market';
  insert into public.card_events (copy_id, kind, from_user, price) values (l.copy_id, 'unlist', uid, l.price);
end $function$;

-- 8. Купить лот. p_price — цена, которую видел покупатель: если она уже другая, ничего не списываем.
create or replace function public.market_buy(p_listing bigint, p_price numeric)
returns table (copy_id bigint, card_id integer, serial integer, price numeric, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
  st text;
  cid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  select k.card_id into cid from public.card_listings x join public.card_copies k on k.id = x.copy_id where x.id = p_listing;
  if not found then raise exception 'market_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into l from public.card_listings x where x.id = p_listing for update;
  if l.status <> 'active' then raise exception 'market_gone'; end if;
  if l.seller_id = uid then raise exception 'market_own'; end if;
  if p_price is distinct from l.price then raise exception 'market_price_changed'; end if;
  select x.state into st from public.card_copies x where x.id = l.copy_id for update;
  if st is distinct from 'market' then raise exception 'market_gone'; end if;
  if public.coins_of(uid) < l.price then raise exception 'market_not_enough'; end if;

  perform public.market_take(l.id, uid);

  return query
    select k.id, k.card_id, k.serial::integer, l.price, public.coins_of(uid)
    from public.card_copies k where k.id = l.copy_id;
end $function$;

-- 9. Создать заявку. Если есть чужой лот не дороже — куплено сразу, по цене лота (kind 'bought'),
--    иначе заявка встаёт в очередь, монеты откладываются (kind 'bid').
create or replace function public.market_bid(p_card integer, p_price numeric)
returns table (kind text, bid_id bigint, copy_id bigint, serial integer, price numeric, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
  bid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  if not exists (select 1 from public.cards c where c.id = p_card) then raise exception 'market_no_card'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('market_card:' || p_card::text));

  select x.* into l from public.card_listings x join public.card_copies k on k.id = x.copy_id
   where k.card_id = p_card and x.status = 'active' and x.seller_id is distinct from uid and x.price <= p_price
   order by x.price, x.updated_at, x.id limit 1 for update of x;
  if found then
    if public.coins_of(uid) < l.price then raise exception 'market_not_enough'; end if;
    perform public.market_take(l.id, uid);
    return query select 'bought'::text, null::bigint, k.id, k.serial::integer, l.price, public.coins_of(uid)
      from public.card_copies k where k.id = l.copy_id;
    return;
  end if;

  if (select count(*) from public.card_bids b where b.buyer_id = uid and b.status = 'active') >= 20 then
    raise exception 'market_bids_limit';
  end if;
  if public.coins_of(uid) < p_price then raise exception 'market_not_enough'; end if;
  insert into public.card_bids (card_id, buyer_id, price) values (p_card, uid, p_price) returning id into bid;
  return query select 'bid'::text, bid, null::bigint, null::integer, p_price, public.coins_of(uid);
end $function$;
revoke all on function public.market_bid(integer, numeric) from public, anon;
grant execute on function public.market_bid(integer, numeric) to authenticated;

-- 10. Изменить цену своей заявки. Подняли не ниже чужого лота — куплено сразу, по цене лота.
create or replace function public.market_bid_reprice(p_bid bigint, p_price numeric)
returns table (kind text, bid_id bigint, copy_id bigint, serial integer, price numeric, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  b public.card_bids%rowtype;
  l public.card_listings%rowtype;
  cid integer;
  avail numeric;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  select x.card_id into cid from public.card_bids x where x.id = p_bid;
  if not found then raise exception 'market_bid_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into b from public.card_bids x where x.id = p_bid for update;
  if b.buyer_id is distinct from uid or b.status <> 'active' then raise exception 'market_bid_gone'; end if;
  avail := public.coins_of(uid) + b.price;   -- сколько будет, если эту заявку убрать

  select x.* into l from public.card_listings x join public.card_copies k on k.id = x.copy_id
   where k.card_id = cid and x.status = 'active' and x.seller_id is distinct from uid and x.price <= p_price
   order by x.price, x.updated_at, x.id limit 1 for update of x;
  if found then
    if avail < l.price then raise exception 'market_not_enough'; end if;
    perform public.market_take(l.id, uid);
    update public.card_bids x set status = 'filled', listing_id = l.id, closed_at = now() where x.id = b.id;
    return query select 'bought'::text, b.id, k.id, k.serial::integer, l.price, public.coins_of(uid)
      from public.card_copies k where k.id = l.copy_id;
    return;
  end if;

  if p_price <> b.price then
    if avail < p_price then raise exception 'market_not_enough'; end if;
    update public.card_bids x set price = p_price, placed_at = clock_timestamp() where x.id = b.id;
  end if;
  return query select 'bid'::text, b.id, null::bigint, null::integer, p_price, public.coins_of(uid);
end $function$;
revoke all on function public.market_bid_reprice(bigint, numeric) from public, anon;
grant execute on function public.market_bid_reprice(bigint, numeric) to authenticated;

-- 11. Отменить свою заявку: отложенные монеты снова доступны. Возвращает новый баланс.
create or replace function public.market_bid_cancel(p_bid bigint)
returns numeric
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  b public.card_bids%rowtype;
  cid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select x.card_id into cid from public.card_bids x where x.id = p_bid;
  if not found then raise exception 'market_bid_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('market_card:' || cid::text));
  select * into b from public.card_bids x where x.id = p_bid for update;
  if b.buyer_id is distinct from uid or b.status <> 'active' then raise exception 'market_bid_gone'; end if;
  update public.card_bids x set status = 'cancelled', closed_at = now() where x.id = b.id;
  return public.coins_of(uid);
end $function$;
revoke all on function public.market_bid_cancel(bigint) from public, anon;
grant execute on function public.market_bid_cancel(bigint) to authenticated;

-- 12. Все висящие заявки (без имён: видно только цену и свою ли), лучшая — первой
create or replace function public.market_bids()
returns table (bid_id bigint, card_id integer, price numeric, mine boolean, placed_at timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select b.id, b.card_id, b.price, b.buyer_id = auth.uid(), b.placed_at
  from public.card_bids b
  where b.status = 'active' and b.buyer_id is not null and public.is_member()
  order by b.card_id, b.price desc, b.placed_at, b.id
$function$;
revoke all on function public.market_bids() from public, anon;
grant execute on function public.market_bids() to authenticated;

-- 13. Мои сделки: что продал и купил (последние 60), с кем и было ли это по заявке
create or replace function public.market_history()
returns table (listing_id bigint, at timestamptz, side text, card_id integer, serial integer,
               price numeric, net numeric, other_name text, via_bid boolean)
language sql stable security definer set search_path to ''
as $function$
  select l.id, l.closed_at, case when l.seller_id = auth.uid() then 'sold' else 'bought' end,
         k.card_id, k.serial::integer, l.price, l.price - l.fee, coalesce(p.display_name, 'Кто-то'),
         exists (select 1 from public.card_bids b where b.listing_id = l.id)
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  left join public.profiles p on p.id = case when l.seller_id = auth.uid() then l.buyer_id else l.seller_id end
  where l.status = 'sold' and (l.seller_id = auth.uid() or l.buyer_id = auth.uid()) and public.is_member()
  order by l.closed_at desc, l.id desc
  limit 60
$function$;
revoke all on function public.market_history() from public, anon;
grant execute on function public.market_history() to authenticated;

-- 14. Данные для уведомления «Заявка исполнена» (вызывает только функция push с ключом service_role)
create or replace function public.push_bid_info(p_listing bigint)
returns table (buyer uuid, card_name text, serial integer, copies integer, price numeric, seller_name text)
language sql stable security definer set search_path to ''
as $function$
  select l.buyer_id, c.name, k.serial::integer, c.copies::integer, l.price, coalesce(p.display_name, 'Кто-то')
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  join public.cards c on c.id = k.card_id
  left join public.profiles p on p.id = l.seller_id
  where l.id = p_listing and l.status = 'sold'
$function$;
revoke all on function public.push_bid_info(bigint) from public, anon, authenticated;
grant execute on function public.push_bid_info(bigint) to service_role;
