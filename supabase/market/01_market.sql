-- КОЛЛЕКЦИОННЫЕ КАРТОЧКИ, этап 3: ЛАВКА (продажа карточек друг другу за монеты)
--
-- Как устроено (простыми словами):
-- * Выставить копию: продавец ставит цену от 0,02 до 99 999,99. Пока копия в лавке, её нет в коллекции
--   (у копии состояние 'market'): её не видно в сетке и на витрине, её не переплавить и не поставить на полку.
--   С витрины — сначала убрать (как перед переплавкой).
-- * Купить: покупатель платит цену, продавец получает цену минус комиссию. Комиссия — 10%, округлённые
--   до сотых, но не меньше 0,01 (поэтому у самых дешёвых, до 0,10, сгорает ровно 0,01). Комиссия сгорает.
-- * Снять с продажи: копия возвращается в коллекцию. Цену можно менять, пока лот висит.
-- * Деньги считает только база. Если цена изменилась, пока покупатель смотрел, — ничего не списывается.
--   Очередь 'points:<id>' общая с казино и карточками: два быстрых нажатия не уведут баланс в минус.
--   Строка лота блокируется (for update): двое не купят одну карточку.
-- * В книге монет (points_ledger) суммы целые, а в лавке — до сотых. Поэтому продажи, как и казино,
--   учитываются в балансе (coins_of) прямо из своей таблицы: покупатель −цена, продавец +(цена − комиссия).
-- * История копии (card_events): выставлена, цена изменена, снята, продана (кто кому и за сколько).
-- * Уведомления: продавцу — «Твою карточку купили», админу — о новом «Свой вопрос».

-- 1. Новые состояния и записи истории; цена в истории — до сотых
alter table public.card_copies drop constraint card_copies_state_check;
alter table public.card_copies add constraint card_copies_state_check
  check (state = any (array['deck', 'owned', 'market', 'melted']));

alter table public.card_events drop constraint card_events_kind_check;
alter table public.card_events add constraint card_events_kind_check
  check (kind = any (array['open', 'melt', 'gift', 'sale', 'list', 'reprice', 'unlist']));
alter table public.card_events alter column price type numeric(9, 2);

-- 2. Лоты. Напрямую таблица закрыта — всё только через функции ниже.
create table public.card_listings (
  id bigint generated always as identity primary key,
  copy_id bigint not null references public.card_copies (id),
  seller_id uuid references auth.users (id) on delete set null,
  price numeric(7, 2) not null check (price between 0.02 and 99999.99),
  status text not null default 'active' check (status in ('active', 'sold', 'cancelled')),
  buyer_id uuid references auth.users (id) on delete set null,
  fee numeric(7, 2),                         -- сколько сгорело (пишется при продаже)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  check (status <> 'sold' or (buyer_id is not null and fee is not null))
);
create unique index card_listings_one_active on public.card_listings (copy_id) where status = 'active';
create index card_listings_seller_sold on public.card_listings (seller_id) where status = 'sold';
create index card_listings_buyer_sold on public.card_listings (buyer_id) where status = 'sold';
alter table public.card_listings enable row level security;
revoke all on public.card_listings from anon, authenticated;

-- 3. Комиссия: 10%, округлённые до сотых, но не меньше 0,01
create or replace function public.market_fee(p_price numeric)
returns numeric language sql immutable set search_path to ''
as $function$
  select greatest(0.01, round(p_price * 0.1, 2))
$function$;
revoke all on function public.market_fee(numeric) from public, anon, authenticated;

-- 4. Баланс = книга монет + казино + продажи в лавке
create or replace function public.coins_of(p_user uuid)
returns numeric
language sql stable security definer set search_path to ''
as $function$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0), 2)
$function$;

-- Проверка цены (одно место для выставления и изменения)
create or replace function public.market_check_price(p_price numeric)
returns void language plpgsql immutable set search_path to ''
as $function$
begin
  if p_price is null or p_price <> round(p_price, 2) or p_price < 0.02 or p_price > 99999.99 then
    raise exception 'market_bad_price';
  end if;
end $function$;
revoke all on function public.market_check_price(numeric) from public, anon, authenticated;

-- 5. Выставить свою копию. Копия уходит из коллекции, пока её не купят или не снимут.
create or replace function public.market_list(p_copy bigint, p_price numeric)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  k public.card_copies%rowtype;
  lid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  select * into k from public.card_copies x where x.id = p_copy for update;
  if not found or k.owner_id is distinct from uid or k.state <> 'owned' then raise exception 'cards_not_yours'; end if;
  if exists (select 1 from public.card_showcase sc where sc.copy_id = p_copy) then raise exception 'cards_in_showcase'; end if;
  update public.card_copies x set state = 'market' where x.id = p_copy;
  insert into public.card_listings (copy_id, seller_id, price) values (p_copy, uid, p_price) returning id into lid;
  insert into public.card_events (copy_id, kind, from_user, price) values (p_copy, 'list', uid, p_price);
  return lid;
end $function$;
revoke all on function public.market_list(bigint, numeric) from public, anon;
grant execute on function public.market_list(bigint, numeric) to authenticated;

-- 6. Изменить цену своего лота
create or replace function public.market_reprice(p_listing bigint, p_price numeric)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.market_check_price(p_price);
  select * into l from public.card_listings x where x.id = p_listing for update;
  if not found or l.seller_id is distinct from uid or l.status <> 'active' then raise exception 'market_gone'; end if;
  if l.price = p_price then return; end if;
  update public.card_listings x set price = p_price, updated_at = now() where x.id = l.id;
  insert into public.card_events (copy_id, kind, from_user, price) values (l.copy_id, 'reprice', uid, p_price);
end $function$;
revoke all on function public.market_reprice(bigint, numeric) from public, anon;
grant execute on function public.market_reprice(bigint, numeric) to authenticated;

-- 7. Снять с продажи: копия возвращается в коллекцию
create or replace function public.market_cancel(p_listing bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into l from public.card_listings x where x.id = p_listing for update;
  if not found or l.seller_id is distinct from uid or l.status <> 'active' then raise exception 'market_gone'; end if;
  update public.card_listings x set status = 'cancelled', closed_at = now(), updated_at = now() where x.id = l.id;
  update public.card_copies x set state = 'owned' where x.id = l.copy_id and x.state = 'market';
  insert into public.card_events (copy_id, kind, from_user, price) values (l.copy_id, 'unlist', uid, l.price);
end $function$;
revoke all on function public.market_cancel(bigint) from public, anon;
grant execute on function public.market_cancel(bigint) to authenticated;

-- 8. Купить. p_price — цена, которую видел покупатель: если она уже другая, ничего не списываем.
create or replace function public.market_buy(p_listing bigint, p_price numeric)
returns table (copy_id bigint, card_id integer, serial integer, price numeric, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  l public.card_listings%rowtype;
  st text;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  select * into l from public.card_listings x where x.id = p_listing for update;
  if not found or l.status <> 'active' then raise exception 'market_gone'; end if;
  if l.seller_id = uid then raise exception 'market_own'; end if;
  if p_price is distinct from l.price then raise exception 'market_price_changed'; end if;
  select x.state into st from public.card_copies x where x.id = l.copy_id for update;
  if st is distinct from 'market' then raise exception 'market_gone'; end if;
  if public.coins_of(uid) < l.price then raise exception 'market_not_enough'; end if;

  update public.card_listings x set status = 'sold', buyer_id = uid, fee = public.market_fee(l.price),
         closed_at = now(), updated_at = now()
   where x.id = l.id;
  update public.card_copies x set state = 'owned', owner_id = uid, obtained_at = now() where x.id = l.copy_id;
  delete from public.card_showcase sc where sc.copy_id = l.copy_id;
  insert into public.card_events (copy_id, kind, from_user, to_user, price) values (l.copy_id, 'sale', l.seller_id, uid, l.price);

  -- уведомление продавцу (уйдёт только после успешной покупки)
  if exists (select 1 from public.push_subscriptions ps where ps.user_id = l.seller_id and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'sale', 'listing_id', l.id));
  end if;

  return query
    select k.id, k.card_id, k.serial::integer, l.price, public.coins_of(uid)
    from public.card_copies k where k.id = l.copy_id;
end $function$;
revoke all on function public.market_buy(bigint, numeric) from public, anon;
grant execute on function public.market_buy(bigint, numeric) to authenticated;

-- 9. Что сейчас в лавке: все лоты, кто продаёт, и цена последней продажи этой карточки
create or replace function public.market_lots()
returns table (listing_id bigint, copy_id bigint, card_id integer, serial integer, price numeric,
               seller_id uuid, seller_name text, seller_color text, seller_avatar text,
               mine boolean, listed_at timestamptz, last_price numeric)
language sql stable security definer set search_path to ''
as $function$
  select l.id, l.copy_id, k.card_id, k.serial::integer, l.price,
         l.seller_id, p.display_name, p.color, p.avatar,
         l.seller_id = auth.uid(), l.created_at,
         (select s.price from public.card_listings s join public.card_copies x on x.id = s.copy_id
           where s.status = 'sold' and x.card_id = k.card_id order by s.closed_at desc limit 1)
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  left join public.profiles p on p.id = l.seller_id
  where l.status = 'active' and public.is_member()
  order by l.price, l.created_at
$function$;
revoke all on function public.market_lots() from public, anon;
grant execute on function public.market_lots() to authenticated;

-- 10. Данные для уведомлений (вызывает только функция push с ключом service_role)
create or replace function public.push_sale_info(p_listing bigint)
returns table (seller uuid, card_name text, serial integer, copies integer, net numeric, buyer_name text)
language sql stable security definer set search_path to ''
as $function$
  select l.seller_id, c.name, k.serial::integer, c.copies::integer, l.price - l.fee, coalesce(p.display_name, 'Кто-то')
  from public.card_listings l
  join public.card_copies k on k.id = l.copy_id
  join public.cards c on c.id = k.card_id
  left join public.profiles p on p.id = l.buyer_id
  where l.id = p_listing and l.status = 'sold'
$function$;
revoke all on function public.push_sale_info(bigint) from public, anon, authenticated;
grant execute on function public.push_sale_info(bigint) to service_role;

-- Новое предложение «Свой вопрос»: кому из админов сообщить (автора не раскрываем и ему самому не шлём)
create or replace function public.push_suggest_info(p_id bigint)
returns table (admin uuid, kind text, body text)
language sql stable security definer set search_path to ''
as $function$
  select a.user_id, s.kind, s.text
  from public.suggestions s
  cross join public.admins a
  where s.id = p_id and s.status = 'pending' and a.user_id <> s.user_id
$function$;
revoke all on function public.push_suggest_info(bigint) from public, anon, authenticated;
grant execute on function public.push_suggest_info(bigint) to service_role;

create or replace function public.push_on_suggest()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  if exists (select 1 from public.admins a join public.push_subscriptions ps on ps.user_id = a.user_id and ps.active
             where a.user_id <> new.user_id) then
    perform public.push_call(jsonb_build_object('type', 'suggest', 'suggestion_id', new.id));
  end if;
  return new;
end $function$;
revoke all on function public.push_on_suggest() from public, anon, authenticated;

create trigger suggestions_push after insert on public.suggestions
  for each row execute function public.push_on_suggest();
