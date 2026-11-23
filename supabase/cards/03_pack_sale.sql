-- ПАКИ: ПОКУПКА ЗА 600 — две недели после конца серии.
--
-- Как устроено (простыми словами):
-- * Колода серии опустела (card_series.closed_at) — две недели любой участник может купить пак за 600 монет.
--   Сколько угодно, без ограничения: цена сама сдерживает.
-- * Первую неделю покупка стоит на месте колоды, вторую — маленькой полосой над блоком коллекции
--   (сайт смотрит на moves_at). Через 14 дней продажа закрывается.
-- * Купленный пак — такой же, как подарочный: открыть или продать в Лавке. Номер — следующий после всех паков,
--   «всего паков» (copies у пака) = подарки + купленные.
-- * Деньги считает только база: цена, которую видел человек, должна совпасть (иначе ничего не списывается);
--   очередь 'points:<id>' — два быстрых нажатия не уведут баланс в минус; очередь 'cards:pack:<серия>' — номера по порядку.
-- * Трата — запись в книге монет (points_ledger, вид 'cards', ref 'pack:<id копии>'); в истории копии — 'buy'.

-- 1. Новая запись истории: пак куплен у сайта
alter table public.card_events drop constraint card_events_kind_check;
alter table public.card_events add constraint card_events_kind_check
  check (kind = any (array['open', 'melt', 'gift', 'sale', 'list', 'reprice', 'unlist', 'grant', 'unpack', 'pack', 'buy']));

-- 2. Продажа паков: идёт ли, цена, когда переезжает (через 7 дней) и когда закончится (через 14), время базы
--    (по нему сайт поправляет свои часы для таймера). Не идёт — пусто.
create or replace function public.cards_pack_sale(p_series integer default 1)
returns table (series_id integer, price integer, moves_at timestamptz, ends_at timestamptz, now_at timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select s.id::integer, 600, s.closed_at + interval '7 days', s.closed_at + interval '14 days', now()
  from public.card_series s
  where s.id = p_series and s.closed_at is not null and now() < s.closed_at + interval '14 days'
    and exists (select 1 from public.cards c where c.series_id = s.id and c.rarity = 'pack')
    and public.is_member()
$function$;
revoke all on function public.cards_pack_sale(integer) from public, anon;
grant execute on function public.cards_pack_sale(integer) to authenticated;

-- 3. Купить пак. p_price — цена, которую видел человек.
create or replace function public.cards_pack_buy(p_series integer, p_price integer)
returns table (copy_id bigint, serial integer, balance numeric, packs integer)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  sale record;
  pid integer;
  ns integer;
  nid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('cards:pack:' || p_series::text));
  select * into sale from public.cards_pack_sale(p_series);
  if not found then raise exception 'cards_pack_sale_over'; end if;
  if p_price is distinct from sale.price then raise exception 'cards_price_changed'; end if;
  if public.coins_of(uid) < sale.price then raise exception 'cards_not_enough'; end if;

  select c.id into pid from public.cards c where c.series_id = p_series and c.rarity = 'pack';
  select coalesce(max(k.serial), 0) + 1 into ns from public.card_copies k where k.card_id = pid;
  insert into public.card_copies (card_id, serial, state, owner_id, obtained_at)
    values (pid, ns, 'owned', uid, now()) returning id into nid;
  update public.cards c set copies = greatest(c.copies + 1, ns) where c.id = pid;   -- всего паков: подарки + купленные
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -sale.price, 'cards', 'pack:' || nid);
  insert into public.card_events (copy_id, kind, to_user, price) values (nid, 'buy', uid, sale.price);

  return query
    select nid, ns, public.coins_of(uid),
           (select count(*)::integer from public.card_copies x where x.card_id = pid and x.owner_id = uid and x.state = 'owned');
end $function$;
revoke all on function public.cards_pack_buy(integer, integer) from public, anon;
grant execute on function public.cards_pack_buy(integer, integer) to authenticated;
