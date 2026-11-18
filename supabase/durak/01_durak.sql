-- «ДУРАК» (китайский дурак): комнаты на 2–5 человек, игра на монеты (ставка от 0).
--
-- Как устроено (простыми словами):
-- * Комната: создатель выбирает ставку, заходит кто угодно (до 5 человек). Ставка уходит «в банк» сразу при входе.
--   Выйти до старта можно — ставка возвращается. Открытых комнат — не больше 3, комната ждёт сутки.
--   Один человек — одна активная комната.
-- * Старт: создатель жмёт «Начать» (от 2 человек), у остальных 30 секунд нажать «Готов».
--   Кто не нажал — выходит из комнаты (ставка возвращается).
-- * Раздача: 52 карты. Каждому 3 закрытые на стол и 6 на выбор: 3 из них кладутся открытыми поверх закрытых,
--   3 остаются в руке. На выбор 60 секунд, иначе база кладёт три старшие. Остальное — колода.
-- * Ход: карта не младше той, что надо побить, или особая; несколько одинаковых — за раз.
--   2 — на любую; 7 — дальше только 2–7; 8 — на любую, кроме 7, бить надо карту под ней (на пустом столе — обычная 8);
--   10 — на любую, кроме 7, стопка в биту. Все 4 карты одного достоинства в стопке — стопка в биту.
--   После биты — добор и ещё один ход. Нечем ходить — забираешь стопку, следующий ходит на пустой стол;
--   4 одинаковые в руке после этого уходят в биту. После хода — добор из колоды до 3.
-- * Откуда ходить: рука → открытые (когда кончились колода и рука) → закрытые (по одной, вслепую;
--   не подошла — забираешь стопку вместе с ней).
-- * 30 секунд на ход. Не успел — забираешь стопку (пустая — база кладёт самую младшую карту).
--   Два раза подряд — выбываешь на последнее место.
-- * Места: кто первым избавился от карт — 1-е, последний с картами — дурак.
--   Выплата за k-е место из N: 2 × ставка × (N − k) / (N − 1), до сотых (остаток копеек — первому). Комиссии нет.
-- * Все карты, руки, колода и стопка видны только базе; телефон получает свой вид (durak_view):
--   свою руку, чужие открытые карты, сколько у кого карт, верх стопки.
--
-- Карта — число 0..51: достоинство = карта / 4 + 2 (2..14, где 11 — валет, 14 — туз), масть = карта % 4 (♠ ♥ ♦ ♣).

-- 1. Комнаты
create table public.durak_rooms (
  id bigint generated always as identity primary key,
  creator uuid not null references public.profiles (id) on delete cascade,
  stake integer not null check (stake between 0 and 100000),
  status text not null default 'open' check (status in ('open', 'ready', 'choose', 'play', 'finished', 'cancelled')),
  created_at timestamptz not null default now(),
  deadline timestamptz,                    -- срок этапа: «Готов», выбор открытых карт, ход
  turn_seat integer,                       -- чей ход (место за столом)
  deck integer[] not null default '{}',    -- колода, верх — последняя карта
  pile integer[] not null default '{}',    -- стопка в центре, верх — последняя карта
  bita integer not null default 0,         -- сколько карт ушло в биту
  version integer not null default 0,      -- растёт при каждом изменении (телефону — знак «перерисуй»)
  log jsonb not null default '[]',         -- последние действия (для экрана)
  started_at timestamptz,
  finished_at timestamptz,
  rematch_of bigint references public.durak_rooms (id) on delete set null,
  rematch_id bigint references public.durak_rooms (id) on delete set null
);
create index durak_rooms_status_idx on public.durak_rooms (status, created_at);
alter table public.durak_rooms enable row level security;
revoke all on public.durak_rooms from anon, authenticated;

-- 2. Игроки в комнате. stake списан при входе, payout — выплата по итогу (пока игра идёт — пусто).
create table public.durak_players (
  room_id bigint not null references public.durak_rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  seat integer not null,
  stake integer not null check (stake >= 0),
  payout numeric(12, 2),
  joined_at timestamptz not null default clock_timestamp(),
  ready boolean not null default false,
  pick integer[] not null default '{}',     -- 6 карт на выбор (этап выбора)
  chosen boolean not null default false,
  hand integer[] not null default '{}',     -- рука
  open integer[] not null default '{}',     -- открытые на столе (по местам 1..3, сыгранная — пусто)
  closed integer[] not null default '{}',   -- закрытые на столе (по местам 1..3, сыгранная — пусто)
  misses integer not null default 0,        -- сколько ходов подряд пропущено по времени
  place integer,                            -- место (1 — вышел первым); пусто — ещё играет
  out_kind text check (out_kind in ('done', 'afk', 'last')),
  primary key (room_id, user_id),
  constraint durak_players_seat_key unique (room_id, seat) deferrable initially deferred
);
create index durak_players_user_idx on public.durak_players (user_id);
alter table public.durak_players enable row level security;
revoke all on public.durak_players from anon, authenticated;

-- 3. Баланс = книга монет + казино + лавка + дурак (ставка списана при входе, выплата — по итогу)
create or replace function public.coins_of(p_user uuid)
returns numeric
language sql stable security definer set search_path to ''
as $function$
  select round(coalesce((select sum(l.amount) from public.points_ledger l where l.user_id = p_user), 0)
        + coalesce((select sum(coalesce(r.payout, 0) - r.bet) from public.casino_rounds r where r.user_id = p_user), 0)
        + coalesce((select sum(m.price - m.fee) from public.card_listings m where m.seller_id = p_user and m.status = 'sold'), 0)
        - coalesce((select sum(m.price) from public.card_listings m where m.buyer_id = p_user and m.status = 'sold'), 0)
        + coalesce((select sum(coalesce(d.payout, 0) - d.stake) from public.durak_players d where d.user_id = p_user), 0), 2)
$function$;

-- 4. Правила карт
-- Какое достоинство надо побить: верхняя карта стопки, но восьмёрки «невидимки» — смотрим под них.
-- Пустой стол — 0 (можно всё). Если в стопке только восьмёрки — первая из них считается обычной 8.
create or replace function public.durak_need(p_pile integer[])
returns integer
language plpgsql immutable set search_path to ''
as $function$
declare i integer; r integer;
begin
  if p_pile is null or cardinality(p_pile) = 0 then return 0; end if;
  for i in reverse cardinality(p_pile)..1 loop
    r := p_pile[i] / 4 + 2;
    if r <> 8 then return r; end if;
  end loop;
  return 8;
end $function$;
revoke all on function public.durak_need(integer[]) from public, anon, authenticated;

-- Можно ли положить карту достоинства p_rank, когда надо побить p_need
create or replace function public.durak_fits(p_rank integer, p_need integer)
returns boolean
language sql immutable set search_path to ''
as $function$
  select case
    when p_need = 0 then true                 -- пустой стол
    when p_rank = 2 then true                 -- двойка — на любую
    when p_need = 7 then p_rank <= 7          -- после семёрки — только 2..7
    when p_rank in (8, 10) then true          -- восьмёрка и десятка — на любую, кроме 7
    else p_rank >= p_need
  end
$function$;
revoke all on function public.durak_fits(integer, integer) from public, anon, authenticated;

-- 5. Служебное: запись в журнал действий комнаты (хранится 8 последних)
create or replace function public.durak_log(p_room bigint, p_entry jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v jsonb;
begin
  select g.log || jsonb_build_array(p_entry) into v from public.durak_rooms g where g.id = p_room;
  while jsonb_array_length(v) > 8 loop v := v - 0; end loop;
  update public.durak_rooms g set log = v, version = g.version + 1 where g.id = p_room;
end $function$;
revoke all on function public.durak_log(bigint, jsonb) from public, anon, authenticated;

-- 6. Отменить комнату: ставки возвращаются (строки игроков удаляются — списание пропадает)
create or replace function public.durak_cancel_room(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  delete from public.durak_players x where x.room_id = p_room;
  update public.durak_rooms g set status = 'cancelled', deadline = null, version = g.version + 1 where g.id = p_room;
end $function$;
revoke all on function public.durak_cancel_room(bigint) from public, anon, authenticated;

-- 7. Раздача: места по порядку, каждому 3 закрытые и 6 на выбор, остальное — колода
create or replace function public.durak_deal(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_deck integer[];
  r record;
  i integer := 0;
begin
  v_deck := array(select x from generate_series(0, 51) x order by random());
  for r in select x.user_id from public.durak_players x where x.room_id = p_room order by x.seat, x.joined_at loop
    update public.durak_players x
       set seat = i, closed = v_deck[1:3], pick = v_deck[4:9], open = '{}', hand = '{}',
           chosen = false, misses = 0, place = null, out_kind = null, payout = null
     where x.room_id = p_room and x.user_id = r.user_id;
    v_deck := v_deck[10:cardinality(v_deck)];
    i := i + 1;
  end loop;
  update public.durak_rooms g
     set status = 'choose', deck = v_deck, pile = '{}', bita = 0, turn_seat = null,
         deadline = now() + interval '60 seconds', started_at = now(), log = '[]', version = g.version + 1
   where g.id = p_room;
end $function$;
revoke all on function public.durak_deal(bigint) from public, anon, authenticated;

-- 8. Все выбрали открытые карты — игра началась, первым ходит случайный игрок
create or replace function public.durak_begin(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_seat integer;
begin
  select x.seat into v_seat from public.durak_players x where x.room_id = p_room order by random() limit 1;
  update public.durak_rooms g set status = 'play', turn_seat = v_seat, deadline = now() + interval '30 seconds'
   where g.id = p_room;
  perform public.durak_log(p_room, jsonb_build_object('kind', 'begin', 'seat', v_seat));
end $function$;
revoke all on function public.durak_begin(bigint) from public, anon, authenticated;

-- 9. Место игроку: «done» — избавился от карт (места сверху: 1, 2, …), «afk» — выбыл по времени (места снизу)
create or replace function public.durak_place(p_room bigint, p_user uuid, p_kind text)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare v_n integer; v_place integer;
begin
  select count(*) into v_n from public.durak_players x where x.room_id = p_room;
  if p_kind = 'afk' then
    v_place := v_n - (select count(*) from public.durak_players x where x.room_id = p_room and x.out_kind = 'afk');
  else
    v_place := 1 + (select count(*) from public.durak_players x where x.room_id = p_room and x.out_kind = 'done');
  end if;
  update public.durak_players x set place = v_place, out_kind = p_kind where x.room_id = p_room and x.user_id = p_user;
  return v_place;
end $function$;
revoke all on function public.durak_place(bigint, uuid, text) from public, anon, authenticated;

-- 10. Итог: выплаты по местам
create or replace function public.durak_finish(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  v_n integer;
  v_rest numeric;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  select count(*) into v_n from public.durak_players x where x.room_id = p_room;
  update public.durak_players x
     set payout = floor(2.0 * g.stake * (v_n - x.place) / greatest(v_n - 1, 1) * 100) / 100
   where x.room_id = p_room;
  v_rest := g.stake * v_n - (select sum(x.payout) from public.durak_players x where x.room_id = p_room);
  update public.durak_players x set payout = x.payout + v_rest where x.room_id = p_room and x.place = 1;
  update public.durak_rooms x set status = 'finished', finished_at = now(), deadline = null, turn_seat = null, version = x.version + 1
   where x.id = p_room;
end $function$;
revoke all on function public.durak_finish(bigint) from public, anon, authenticated;

-- 11. После действия: остался один — итог; иначе ход тому же (после биты) или следующему
create or replace function public.durak_after(p_room bigint, p_seat integer, p_again boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_next integer; v_user uuid;
begin
  if (select count(*) from public.durak_players x where x.room_id = p_room and x.place is null) <= 1 then
    select x.user_id into v_user from public.durak_players x where x.room_id = p_room and x.place is null;
    if v_user is not null then
      update public.durak_players x
         set place = 1 + (select count(*) from public.durak_players y where y.room_id = p_room and y.out_kind = 'done'), out_kind = 'last'
       where x.room_id = p_room and x.user_id = v_user;
    end if;
    perform public.durak_finish(p_room);
    return;
  end if;
  if p_again and exists (select 1 from public.durak_players x where x.room_id = p_room and x.seat = p_seat and x.place is null) then
    v_next := p_seat;
  else
    select x.seat into v_next from public.durak_players x
     where x.room_id = p_room and x.place is null
     order by (x.seat <= p_seat), x.seat limit 1;
  end if;
  update public.durak_rooms g set turn_seat = v_next, deadline = now() + interval '30 seconds', version = g.version + 1
   where g.id = p_room;
end $function$;
revoke all on function public.durak_after(bigint, integer, boolean) from public, anon, authenticated;

-- 12. Ход. p_kind: 'play' — карты с руки или открытые со стола, 'flip' — закрытая карта (место 1..3), 'take' — забрать стопку.
--     p_auto — ход сделала база, потому что время вышло (тогда забрать стопку можно всегда).
create or replace function public.durak_move(p_room bigint, p_user uuid, p_kind text, p_cards integer[], p_pos integer, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_hand integer[]; v_open integer[]; v_closed integer[]; v_pile integer[]; v_deck integer[]; v_bita integer;
  v_need integer; v_rank integer; v_card integer; v_src text; v_rr integer;
  v_burn boolean := false; v_took boolean := false; v_out boolean;
  v_entry jsonb;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'play' then raise exception 'durak_gone'; end if;
  select * into p from public.durak_players x where x.room_id = p_room and x.user_id = p_user;
  if not found or p.place is not null or p.seat is distinct from g.turn_seat then raise exception 'durak_not_turn'; end if;

  v_hand := p.hand; v_open := p.open; v_closed := p.closed;
  v_pile := g.pile; v_deck := g.deck; v_bita := g.bita;
  v_need := public.durak_need(v_pile);
  v_src := case when cardinality(v_hand) > 0 then 'hand'
                when cardinality(array_remove(v_open, null)) > 0 then 'open'
                else 'closed' end;

  if p_kind = 'play' then
    if v_src = 'closed' or p_cards is null or cardinality(p_cards) not between 1 and 4
       or exists (select 1 from unnest(p_cards) x where x is null or x not between 0 and 51)
       or (select count(distinct x) from unnest(p_cards) x) <> cardinality(p_cards)
       or (select count(distinct x / 4) from unnest(p_cards) x) <> 1 then
      raise exception 'durak_bad_move';
    end if;
    v_rank := p_cards[1] / 4 + 2;
    if v_src = 'hand' then
      if not (v_hand @> p_cards) then raise exception 'durak_bad_move'; end if;
      v_hand := array(select x from unnest(v_hand) x where x <> all (p_cards));
    else
      if not (v_open @> p_cards) then raise exception 'durak_bad_move'; end if;
      v_open := array(select case when t.x = any (p_cards) then null else t.x end
                      from unnest(v_open) with ordinality t(x, i) order by t.i);
    end if;
    if not public.durak_fits(v_rank, v_need) then raise exception 'durak_bad_move'; end if;
    v_pile := v_pile || p_cards;
    v_burn := v_rank = 10 or (select count(*) from unnest(v_pile) x where x / 4 + 2 = v_rank) >= 4;
    v_entry := jsonb_build_object('kind', 'play', 'cards', to_jsonb(p_cards), 'from', v_src);

  elsif p_kind = 'flip' then
    if v_src <> 'closed' or p_pos is null or p_pos < 1 or p_pos > cardinality(v_closed) or v_closed[p_pos] is null then
      raise exception 'durak_bad_move';
    end if;
    v_card := v_closed[p_pos];
    v_closed[p_pos] := null;
    v_rank := v_card / 4 + 2;
    if public.durak_fits(v_rank, v_need) then
      v_pile := v_pile || v_card;
      v_burn := v_rank = 10 or (select count(*) from unnest(v_pile) x where x / 4 + 2 = v_rank) >= 4;
      v_entry := jsonb_build_object('kind', 'play', 'cards', jsonb_build_array(v_card), 'from', 'closed');
    else
      v_took := true;
      v_entry := jsonb_build_object('kind', 'flip_take', 'cards', jsonb_build_array(v_card), 'n', cardinality(v_pile) + 1);
      v_hand := v_hand || v_pile || v_card;
      v_pile := '{}';
    end if;

  elsif p_kind = 'take' then
    if cardinality(v_pile) = 0 then raise exception 'durak_bad_move'; end if;
    if not p_auto then
      if v_src = 'closed' then raise exception 'durak_bad_move'; end if;
      if exists (select 1 from unnest(case when v_src = 'hand' then v_hand else v_open end) x
                 where x is not null and public.durak_fits(x / 4 + 2, v_need)) then
        raise exception 'durak_can_play';
      end if;
    end if;
    v_took := true;
    v_entry := jsonb_build_object('kind', 'take', 'n', cardinality(v_pile));
    v_hand := v_hand || v_pile;
    v_pile := '{}';

  else
    raise exception 'durak_bad_move';
  end if;

  -- забрал стопку: 4 одинаковые в руке уходят в биту
  if v_took then
    for v_rr in select x / 4 from unnest(v_hand) x group by x / 4 having count(*) >= 4 loop
      v_hand := array(select x from unnest(v_hand) x where x / 4 <> v_rr);
      v_bita := v_bita + 4;
      v_entry := v_entry || jsonb_build_object('four', v_rr + 2);
    end loop;
  end if;
  -- бита: десятка или все 4 одного достоинства в стопке
  if v_burn then
    v_bita := v_bita + cardinality(v_pile);
    v_pile := '{}';
    v_entry := v_entry || jsonb_build_object('burn', true);
  end if;
  -- добор из колоды до 3
  while cardinality(v_hand) < 3 and cardinality(v_deck) > 0 loop
    v_hand := v_hand || v_deck[cardinality(v_deck)];
    v_deck := v_deck[1:cardinality(v_deck) - 1];
  end loop;
  v_out := cardinality(v_hand) = 0 and cardinality(array_remove(v_open, null)) = 0 and cardinality(array_remove(v_closed, null)) = 0;

  update public.durak_players x
     set hand = v_hand, open = v_open, closed = v_closed, misses = case when p_auto then x.misses else 0 end
   where x.room_id = p_room and x.user_id = p_user;
  update public.durak_rooms x set pile = v_pile, deck = v_deck, bita = v_bita where x.id = p_room;
  if v_out then
    v_entry := v_entry || jsonb_build_object('out', public.durak_place(p_room, p_user, 'done'));
  end if;
  perform public.durak_log(p_room, v_entry || jsonb_build_object('seat', p.seat, 'auto', p_auto));
  perform public.durak_after(p_room, p.seat, v_burn and not v_out);
end $function$;
revoke all on function public.durak_move(bigint, uuid, text, integer[], integer, boolean) from public, anon, authenticated;

-- 13. Сроки: комната ждёт сутки, «Готов» — 30 с, выбор открытых — 60 с, ход — 30 с (+2 с на задержку связи)
create or replace function public.durak_tick(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_card integer; v_src text; v_pos integer;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found then return; end if;

  if g.status = 'open' then
    if g.created_at < now() - interval '24 hours' or not exists (select 1 from public.durak_players x where x.room_id = g.id) then
      perform public.durak_cancel_room(g.id);
    end if;

  elsif g.status = 'ready' and g.deadline < now() - interval '2 seconds' then
    delete from public.durak_players x where x.room_id = g.id and not x.ready;   -- не успели — ставка возвращается
    if (select count(*) from public.durak_players x where x.room_id = g.id) >= 2 then
      perform public.durak_deal(g.id);
    elsif exists (select 1 from public.durak_players x where x.room_id = g.id) then
      update public.durak_players x set ready = false where x.room_id = g.id;
      update public.durak_rooms x set status = 'open', deadline = null, version = x.version + 1 where x.id = g.id;
    else
      perform public.durak_cancel_room(g.id);
    end if;

  elsif g.status = 'choose' and g.deadline < now() - interval '2 seconds' then
    -- не выбрали — открытыми кладутся три старшие
    update public.durak_players x
       set open = array(select y from unnest(x.pick) y order by y desc limit 3),
           hand = array(select y from unnest(x.pick) y order by y desc offset 3),
           pick = '{}', chosen = true
     where x.room_id = g.id and not x.chosen;
    perform public.durak_begin(g.id);

  elsif g.status = 'play' and g.deadline < now() - interval '2 seconds' then
    select * into p from public.durak_players x where x.room_id = g.id and x.seat = g.turn_seat and x.place is null;
    if not found then
      perform public.durak_after(g.id, coalesce(g.turn_seat, 0), false);
      return;
    end if;
    update public.durak_players x set misses = x.misses + 1 where x.room_id = g.id and x.user_id = p.user_id;
    if p.misses + 1 >= 2 then
      -- второй пропуск подряд: выбывает на последнее свободное место, его карты уходят в биту
      update public.durak_rooms x
         set bita = x.bita + cardinality(p.hand) + cardinality(array_remove(p.open, null)) + cardinality(array_remove(p.closed, null))
       where x.id = g.id;
      update public.durak_players x set hand = '{}', open = '{}', closed = '{}' where x.room_id = g.id and x.user_id = p.user_id;
      perform public.durak_log(g.id, jsonb_build_object('kind', 'afk', 'seat', p.seat, 'out', public.durak_place(g.id, p.user_id, 'afk')));
      perform public.durak_after(g.id, p.seat, false);
    elsif cardinality(g.pile) > 0 then
      perform public.durak_move(g.id, p.user_id, 'take', null, null, true);
    else
      -- стол пустой: база кладёт самую младшую карту (закрытые — первую по порядку)
      v_src := case when cardinality(p.hand) > 0 then 'hand' when cardinality(array_remove(p.open, null)) > 0 then 'open' else 'closed' end;
      if v_src = 'closed' then
        select t.i into v_pos from unnest(p.closed) with ordinality t(x, i) where t.x is not null order by t.i limit 1;
        perform public.durak_move(g.id, p.user_id, 'flip', null, v_pos::integer, true);
      else
        select min(x) into v_card from unnest(case when v_src = 'hand' then p.hand else p.open end) x;
        perform public.durak_move(g.id, p.user_id, 'play', array[v_card], null, true);
      end if;
    end if;
  end if;
end $function$;
revoke all on function public.durak_tick(bigint) from public, anon, authenticated;

-- 14. Войти в комнату (общая часть для «войти» и «ещё раз»)
create or replace function public.durak_enter(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  v_seat integer;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' then raise exception 'durak_gone'; end if;
  if exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = p_user) then return; end if;
  if exists (select 1 from public.durak_players x join public.durak_rooms r on r.id = x.room_id
             where x.user_id = p_user and r.status in ('open', 'ready', 'choose', 'play')) then
    raise exception 'durak_busy';
  end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room) >= 5 then raise exception 'durak_full'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < g.stake then raise exception 'durak_not_enough'; end if;
  select min(s) into v_seat from generate_series(0, 4) s
   where s not in (select x.seat from public.durak_players x where x.room_id = p_room);
  insert into public.durak_players (room_id, user_id, seat, stake) values (p_room, p_user, v_seat, g.stake);
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.durak_enter(bigint, uuid) from public, anon, authenticated;

-- 15. Новая комната (общая часть для «создать» и «ещё раз»)
create or replace function public.durak_new(p_user uuid, p_stake integer, p_from bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare v_id bigint;
begin
  if p_stake is null or p_stake < 0 or p_stake > 100000 then raise exception 'durak_bad_stake'; end if;
  if exists (select 1 from public.durak_players x join public.durak_rooms r on r.id = x.room_id
             where x.user_id = p_user and r.status in ('open', 'ready', 'choose', 'play')) then
    raise exception 'durak_busy';
  end if;
  perform pg_advisory_xact_lock(hashtext('durak:rooms'));
  if (select count(*) from public.durak_rooms r where r.status in ('open', 'ready')) >= 3 then raise exception 'durak_too_many'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < p_stake then raise exception 'durak_not_enough'; end if;
  insert into public.durak_rooms (creator, stake, rematch_of) values (p_user, p_stake, p_from) returning id into v_id;
  insert into public.durak_players (room_id, user_id, seat, stake) values (v_id, p_user, 0, p_stake);
  if exists (select 1 from public.push_subscriptions ps where ps.user_id <> p_user and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', v_id, 'event', 'room'));
  end if;
  return v_id;
end $function$;
revoke all on function public.durak_new(uuid, integer, bigint) from public, anon, authenticated;

-- ===== Функции для телефона =====

-- Создать комнату
create or replace function public.durak_create(p_stake integer)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  return public.durak_new(auth.uid(), p_stake, null);
end $function$;
revoke all on function public.durak_create(integer) from public, anon;
grant execute on function public.durak_create(integer) to authenticated;

-- Войти в открытую комнату
create or replace function public.durak_join(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform public.durak_enter(p_room, auth.uid());
end $function$;
revoke all on function public.durak_join(bigint) from public, anon;
grant execute on function public.durak_join(bigint) to authenticated;

-- Выйти из комнаты до раздачи (ставка возвращается). Ушёл создатель — комнату ведёт тот, кто зашёл раньше всех.
-- Если шла проверка «Готов» — она отменяется. Никого не осталось — комната закрывается.
create or replace function public.durak_leave(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  v_next uuid;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status not in ('open', 'ready')
     or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  delete from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  select x.user_id into v_next from public.durak_players x where x.room_id = p_room order by x.joined_at limit 1;
  if v_next is null then
    perform public.durak_cancel_room(p_room);
    return;
  end if;
  update public.durak_players x set ready = false where x.room_id = p_room;
  update public.durak_rooms x
     set creator = case when x.creator = uid then v_next else x.creator end,
         status = 'open', deadline = null, version = x.version + 1
   where x.id = p_room;
end $function$;
revoke all on function public.durak_leave(bigint) from public, anon;
grant execute on function public.durak_leave(bigint) to authenticated;

-- «Начать» (только создатель, от 2 человек): у остальных 30 секунд на «Готов»
create or replace function public.durak_start(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' or g.creator <> uid then raise exception 'durak_gone'; end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room) < 2 then raise exception 'durak_alone'; end if;
  update public.durak_players x set ready = (x.user_id = uid) where x.room_id = p_room;
  update public.durak_rooms x set status = 'ready', deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  if exists (select 1 from public.push_subscriptions ps join public.durak_players x on x.user_id = ps.user_id
             where x.room_id = p_room and x.user_id <> uid and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', p_room, 'event', 'start'));
  end if;
end $function$;
revoke all on function public.durak_start(bigint) from public, anon;
grant execute on function public.durak_start(bigint) to authenticated;

-- «Готов». Готовы все — раздача.
create or replace function public.durak_ready(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform 1 from public.durak_rooms x where x.id = p_room and x.status = 'ready' for update;
  if not found or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  update public.durak_players x set ready = true where x.room_id = p_room and x.user_id = uid;
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.ready) then
    perform public.durak_deal(p_room);
  end if;
end $function$;
revoke all on function public.durak_ready(bigint) from public, anon;
grant execute on function public.durak_ready(bigint) to authenticated;

-- Выбрать 3 открытые карты из шести. Выбрали все — игра началась.
create or replace function public.durak_choose(p_room bigint, p_cards integer[])
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  p public.durak_players%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform 1 from public.durak_rooms x where x.id = p_room and x.status = 'choose' for update;
  if not found then raise exception 'durak_gone'; end if;
  select * into p from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  if not found or p.chosen then raise exception 'durak_gone'; end if;
  if p_cards is null or cardinality(p_cards) <> 3
     or (select count(distinct x) from unnest(p_cards) x) <> 3 or not (p.pick @> p_cards) then
    raise exception 'durak_bad_move';
  end if;
  update public.durak_players x
     set open = p_cards, hand = array(select y from unnest(x.pick) y where y <> all (p_cards)), pick = '{}', chosen = true
   where x.room_id = p_room and x.user_id = uid;
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.chosen) then
    perform public.durak_begin(p_room);
  end if;
end $function$;
revoke all on function public.durak_choose(bigint, integer[]) from public, anon;
grant execute on function public.durak_choose(bigint, integer[]) to authenticated;

-- Положить карты (с руки или открытые со стола)
create or replace function public.durak_play(p_room bigint, p_cards integer[])
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform public.durak_move(p_room, auth.uid(), 'play', p_cards, null, false);
end $function$;
revoke all on function public.durak_play(bigint, integer[]) from public, anon;
grant execute on function public.durak_play(bigint, integer[]) to authenticated;

-- Открыть закрытую карту (место 1..3)
create or replace function public.durak_flip(p_room bigint, p_pos integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform public.durak_move(p_room, auth.uid(), 'flip', null, p_pos, false);
end $function$;
revoke all on function public.durak_flip(bigint, integer) from public, anon;
grant execute on function public.durak_flip(bigint, integer) to authenticated;

-- Забрать стопку (только когда нечем ходить)
create or replace function public.durak_take(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  perform public.durak_move(p_room, auth.uid(), 'take', null, null, false);
end $function$;
revoke all on function public.durak_take(bigint) from public, anon;
grant execute on function public.durak_take(bigint) to authenticated;

-- «Ещё раз»: та же ставка. Если кто-то из этой игры уже открыл новую комнату — заходим в неё.
create or replace function public.durak_rematch(p_room bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  v_id bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'finished'
     or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  if g.rematch_id is not null then
    perform public.durak_tick(g.rematch_id);
    if exists (select 1 from public.durak_players x where x.room_id = g.rematch_id and x.user_id = uid) then
      return g.rematch_id;
    end if;
    if exists (select 1 from public.durak_rooms x where x.id = g.rematch_id and x.status = 'open') then
      perform public.durak_enter(g.rematch_id, uid);
      update public.durak_rooms x set version = x.version + 1 where x.id = p_room;   -- остальные увидят «уже N в комнате»
      return g.rematch_id;
    end if;
  end if;
  v_id := public.durak_new(uid, g.stake, g.id);
  update public.durak_rooms x set rematch_id = v_id, version = x.version + 1 where x.id = p_room;
  return v_id;
end $function$;
revoke all on function public.durak_rematch(bigint) from public, anon;
grant execute on function public.durak_rematch(bigint) to authenticated;

-- Вид комнаты для телефона: всё, что этот игрок может видеть
create or replace function public.durak_view(p_room bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  me public.durak_players%rowtype;
  v_need integer; v_src text; v_top integer[] := '{}'; i integer;
  v_play jsonb := '[]'; v_take boolean := false; v_turn boolean;
  v_players jsonb; v_rematch jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.durak_rooms x where x.id = p_room;
  if found and ((g.status in ('ready', 'choose', 'play') and g.deadline < now() - interval '2 seconds')
                or (g.status = 'open' and g.created_at < now() - interval '24 hours')) then
    perform public.durak_tick(p_room);
    select * into g from public.durak_rooms x where x.id = p_room;
  end if;
  if not found then raise exception 'durak_gone'; end if;
  select * into me from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  if not found then
    -- не игрок: открытую комнату можно посмотреть (кто в ней), чужую игру — нет
    if g.status not in ('open', 'ready', 'cancelled') then raise exception 'durak_gone'; end if;
  end if;

  v_need := public.durak_need(g.pile);
  -- видно: верхнюю карту, а если сверху восьмёрки — и карту под ними
  if cardinality(g.pile) > 0 then
    for i in reverse cardinality(g.pile)..1 loop
      v_top := array_prepend(g.pile[i], v_top);
      exit when g.pile[i] / 4 + 2 <> 8;
    end loop;
  end if;

  v_turn := g.status = 'play' and me.user_id is not null and me.place is null and me.seat = g.turn_seat;
  if me.user_id is not null then
    v_src := case when cardinality(me.hand) > 0 then 'hand'
                  when cardinality(array_remove(me.open, null)) > 0 then 'open'
                  else 'closed' end;
    if v_turn and v_src <> 'closed' then
      v_play := coalesce((select jsonb_agg(x order by x) from unnest(case when v_src = 'hand' then me.hand else me.open end) x
                          where x is not null and public.durak_fits(x / 4 + 2, v_need)), '[]');
      v_take := v_play = '[]' and cardinality(g.pile) > 0;
    end if;
  end if;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(pr.display_name, 'Без имени'), 'color', pr.color, 'avatar', pr.avatar,
           'me', x.user_id = uid, 'creator', x.user_id = g.creator, 'ready', x.ready, 'chosen', x.chosen,
           'hand', cardinality(x.hand),
           'open', case when g.status in ('play', 'finished') then to_jsonb(x.open) end,
           'closed', to_jsonb(array(select t.y is not null from unnest(x.closed) with ordinality t(y, n) order by t.n)),
           'misses', x.misses, 'place', x.place, 'out', x.out_kind, 'payout', x.payout
         ) order by x.seat)
    into v_players
    from public.durak_players x left join public.profiles pr on pr.id = x.user_id
   where x.room_id = p_room;

  if g.rematch_id is not null then
    select jsonb_build_object('id', r.id, 'status', r.status,
             'in', exists (select 1 from public.durak_players y where y.room_id = r.id and y.user_id = uid),
             'n', (select count(*) from public.durak_players y where y.room_id = r.id))
      into v_rematch from public.durak_rooms r where r.id = g.rematch_id and r.status in ('open', 'ready');
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'stake', g.stake, 'version', g.version,
    'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'turn', g.turn_seat, 'need', v_need, 'pile_top', to_jsonb(v_top), 'pile_n', cardinality(g.pile),
    'deck_n', cardinality(g.deck), 'bita', g.bita, 'log', g.log,
    'players', coalesce(v_players, '[]'),
    'rematch', v_rematch,
    'my', case when me.user_id is null then null else jsonb_build_object(
      'seat', me.seat, 'ready', me.ready, 'chosen', me.chosen, 'place', me.place, 'payout', me.payout, 'stake', me.stake,
      'hand', coalesce((select jsonb_agg(x order by x) from unnest(me.hand) x), '[]'),
      'pick', coalesce((select jsonb_agg(x order by x) from unnest(me.pick) x), '[]'),
      'open', to_jsonb(me.open),
      'src', v_src, 'turn', v_turn, 'playable', v_play, 'can_take', v_take) end
  );
end $function$;
revoke all on function public.durak_view(bigint) from public, anon;
grant execute on function public.durak_view(bigint) to authenticated;

-- Список: открытые комнаты (все), моя текущая игра и мои последние законченные (3 дня)
create or replace function public.durak_list()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  r record;
  v jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select g.id from public.durak_rooms g
           where (g.status = 'open' and (g.created_at < now() - interval '24 hours'
                    or not exists (select 1 from public.durak_players x where x.room_id = g.id)))
              or (g.status in ('ready', 'choose', 'play') and g.deadline < now() - interval '2 seconds') loop
    perform public.durak_tick(r.id);
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.created_at desc), '[]') into v from (
    select g.id, g.status, g.stake, g.created_at, g.finished_at,
           g.status in ('open', 'ready', 'choose', 'play') as active,
           exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid) as mine,
           g.creator = uid as is_creator,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(pr.display_name, 'Без имени'), 'color', pr.color,
                                                'avatar', pr.avatar, 'place', x.place, 'payout', x.payout) order by x.seat)
              from public.durak_players x left join public.profiles pr on pr.id = x.user_id where x.room_id = g.id) as players,
           (select x.place from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_place,
           (select x.payout from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_payout
      from public.durak_rooms g
     where g.status in ('open', 'ready')
        or (g.status in ('choose', 'play') and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
revoke all on function public.durak_list() from public, anon;
grant execute on function public.durak_list() to authenticated;

-- Кому отправить уведомление (только с ключом сервера):
-- 'room' — новая комната: всем, кто не в ней; 'start' — «жми Готов»: тем, кто в комнате и ещё не готов
create or replace function public.push_durak_targets(p_id bigint, p_event text)
returns table (user_id uuid, creator_name text, stake integer)
language sql stable security definer set search_path to ''
as $function$
  select distinct ps.user_id, coalesce(pr.display_name, 'Кто-то'), g.stake
  from public.durak_rooms g
  join public.push_subscriptions ps on ps.active
  left join public.profiles pr on pr.id = g.creator
  where g.id = p_id
    and ((p_event = 'room' and g.status = 'open'
          and not exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = ps.user_id))
      or (p_event = 'start' and g.status = 'ready'
          and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = ps.user_id and not x.ready)))
$function$;
revoke all on function public.push_durak_targets(bigint, text) from public, anon, authenticated;
grant execute on function public.push_durak_targets(bigint, text) to service_role;
