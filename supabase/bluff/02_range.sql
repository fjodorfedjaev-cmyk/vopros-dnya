-- «ВЕРЮ — НЕ ВЕРЮ»: колода «от … до …» — любой отрезок номиналов (например, от 5 до 10). 22.11.2026.
-- Раньше колода была «от … до туза». Теперь у комнаты есть и верхний номинал (high_rank, по умолчанию 14 — туз).
-- Старые комнаты и вызовы без p_high остаются «до туза». Меняются: bluff_deck_n (три числа), bluff_new, bluff_create
-- (новое необязательное p_high), bluff_max_seats, bluff_deal, bluff_move (номинал — внутри отрезка), bluff_bot_move,
-- bluff_rematch, bluff_view и bluff_list (поле high).

-- 1. Верхний номинал колоды
alter table public.bluff_rooms add column high_rank integer not null default 14 check (high_rank between 2 and 14);
alter table public.bluff_rooms add constraint bluff_rooms_range check (low_rank <= high_rank);

-- 2. Сколько карт в колоде: от p_low до p_high (по 4) + джокеры
create or replace function public.bluff_deck_n(p_low integer, p_high integer, p_jokers integer)
returns integer
language sql immutable set search_path to ''
as $function$ select (p_high - p_low + 1) * 4 + p_jokers $function$;
revoke all on function public.bluff_deck_n(integer, integer, integer) from public, anon, authenticated;

-- 3. Создать комнату: колода «от p_low до p_high»
drop function public.bluff_create(integer, integer, integer, boolean);
drop function public.bluff_new(uuid, integer, integer, integer, bigint, boolean);
create or replace function public.bluff_new(p_user uuid, p_stake integer, p_low integer, p_high integer, p_jokers integer, p_from bigint, p_test boolean)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare v_id bigint;
begin
  if p_test and not exists (select 1 from public.admins a where a.user_id = p_user) then raise exception 'not_admin'; end if;
  if p_test then p_stake := 0; end if;
  if p_stake is null or p_stake < 0 or p_stake > 100000 then raise exception 'bluff_bad_stake'; end if;
  p_high := coalesce(p_high, 14);
  if p_low is null or p_low < 2 or p_high > 14 or p_low > p_high or p_jokers is null or p_jokers < 0 or p_jokers > 4 then
    raise exception 'bluff_bad_deck';
  end if;
  if exists (select 1 from public.bluff_players x join public.bluff_rooms r on r.id = x.room_id
             where x.user_id = p_user and x.place is null and r.status in ('open', 'ready', 'play')) then
    raise exception 'bluff_busy';
  end if;
  perform pg_advisory_xact_lock(hashtext('bluff:rooms'));
  if not p_test and (select count(*) from public.bluff_rooms r where r.status in ('open', 'ready') and not r.test) >= 3 then
    raise exception 'bluff_too_many';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < p_stake then raise exception 'bluff_not_enough'; end if;
  insert into public.bluff_rooms (creator, stake, low_rank, high_rank, jokers, rematch_of, test)
  values (p_user, p_stake, p_low, p_high, p_jokers, p_from, p_test) returning id into v_id;
  insert into public.bluff_players (room_id, user_id, seat, stake) values (v_id, p_user, 0, p_stake);
  return v_id;
end $function$;
revoke all on function public.bluff_new(uuid, integer, integer, integer, integer, bigint, boolean) from public, anon, authenticated;

create or replace function public.bluff_create(p_stake integer, p_low integer, p_jokers integer, p_test boolean default false, p_high integer default 14)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  return public.bluff_new(auth.uid(), p_stake, p_low, p_high, p_jokers, null, coalesce(p_test, false));
end $function$;
revoke all on function public.bluff_create(integer, integer, integer, boolean, integer) from public, anon;
grant execute on function public.bluff_create(integer, integer, integer, boolean, integer) to authenticated;

-- 4. Мест: не больше 6 и не больше, чем карт в колоде
create or replace function public.bluff_max_seats(p_room bigint)
returns integer
language sql stable security definer set search_path to ''
as $function$ select least(6, public.bluff_deck_n(g.low_rank, g.high_rank, g.jokers)) from public.bluff_rooms g where g.id = p_room $function$;
revoke all on function public.bluff_max_seats(bigint) from public, anon, authenticated;

-- 5. Раздача: только номиналы отрезка
create or replace function public.bluff_deal(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  v_deck integer[];
  v_n integer;
  v_seat integer;
  r record;
  i integer := 0;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  v_deck := array(select c from (select x as c from generate_series(0, 51) x where x / 4 + 2 between g.low_rank and g.high_rank
                                 union all select 52 + j from generate_series(0, g.jokers - 1) j) t order by random());
  select count(*) into v_n from public.bluff_players x where x.room_id = p_room;
  for r in select x.user_id from public.bluff_players x where x.room_id = p_room order by x.seat, x.joined_at loop
    update public.bluff_players x
       set seat = i, hand = array(select v_deck[k] from generate_series(i + 1, cardinality(v_deck), v_n) k),
           misses = 0, place = null, out_kind = null, payout = null
     where x.room_id = p_room and x.user_id = r.user_id;
    i := i + 1;
  end loop;
  update public.bluff_rooms x
     set status = 'play', pile = '{}', claim_rank = null, last_seat = null, last_n = 0, bita = 0, turn_seat = null,
         deadline = null, started_at = now(), log = '[]', version = x.version + 1
   where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'deal'));
  for r in select x.user_id from public.bluff_players x where x.room_id = p_room order by x.seat loop
    perform public.bluff_fours(p_room, r.user_id);     -- четвёрки с раздачи — сразу в биту
  end loop;
  perform public.bluff_outs(p_room, null);               -- ушло всё четвёрками — сразу вышел
  if public.bluff_end_check(p_room) then return; end if;
  select x.seat into v_seat from public.bluff_players x where x.room_id = p_room and x.place is null order by random() limit 1;
  update public.bluff_rooms x set turn_seat = v_seat, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'begin', 'seat', v_seat));
end $function$;
revoke all on function public.bluff_deal(bigint) from public, anon, authenticated;

-- 6. Ход: номинал круга — внутри отрезка
create or replace function public.bluff_move(p_room bigint, p_user uuid, p_kind text, p_cards integer[], p_rank integer, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_last integer[];
  v_truth boolean;
  v_taker uuid;
  v_taker_seat integer;
  v_start integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'play' then raise exception 'bluff_gone'; end if;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if not found or me.place is not null or me.seat is distinct from g.turn_seat then raise exception 'bluff_not_turn'; end if;
  if g.last_seat is not null then
    select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  end if;

  if p_kind = 'put' then
    if p_cards is null or cardinality(p_cards) = 0
       or (select count(distinct c) from unnest(p_cards) c) <> cardinality(p_cards)
       or exists (select 1 from unnest(p_cards) c where not (c = any (me.hand))) then
      raise exception 'bluff_bad_move';
    end if;
    if g.claim_rank is null then
      if p_rank is null or p_rank < g.low_rank or p_rank > g.high_rank then raise exception 'bluff_bad_rank'; end if;
      g.claim_rank := p_rank;
    end if;
    update public.bluff_players x
       set hand = array(select c from unnest(me.hand) c where not (c = any (p_cards))),
           misses = case when coalesce(p_auto, false) then x.misses else 0 end
     where x.room_id = p_room and x.user_id = p_user;
    update public.bluff_rooms x set pile = x.pile || p_cards, claim_rank = g.claim_rank, last_seat = me.seat, last_n = cardinality(p_cards)
     where x.id = p_room;
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'put', 'seat', me.seat, 'n', cardinality(p_cards), 'rank', g.claim_rank,
                                                        'new', g.last_seat is null, 'auto', coalesce(p_auto, false)));
    -- ход предыдущего принят: если он положил последние карты — вышел
    if v_prev.user_id is not null and v_prev.place is null and cardinality(v_prev.hand) = 0 then
      perform public.bluff_log(p_room, jsonb_build_object('kind', 'out', 'seat', v_prev.seat, 'place', public.bluff_place(p_room, v_prev.user_id, 'done')));
    end if;
    if public.bluff_end_check(p_room) then return; end if;
    v_start := public.bluff_next(p_room, me.seat);
    update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    return;
  end if;

  if p_kind not in ('trust', 'doubt') then raise exception 'bluff_bad_move'; end if;
  if g.claim_rank is null or g.last_seat is null or g.last_seat = me.seat then raise exception 'bluff_bad_move'; end if;
  update public.bluff_players x set misses = case when coalesce(p_auto, false) then x.misses else 0 end
   where x.room_id = p_room and x.user_id = p_user;
  v_last := g.pile[cardinality(g.pile) - g.last_n + 1 : cardinality(g.pile)];
  v_truth := not exists (select 1 from unnest(v_last) c where c < 52 and c / 4 + 2 <> g.claim_rank);   -- джокер — всегда правда
  if p_kind = 'doubt' then
    v_taker := case when v_truth then me.user_id else v_prev.user_id end;
  else
    v_taker := case when v_truth then null else me.user_id end;
  end if;
  -- забирать некому (положивший уже вышел из игры) — стопка в биту
  if v_taker is not null and exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker and x.place is not null) then
    v_taker := null;
  end if;
  select x.seat into v_taker_seat from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'reveal', 'seat', me.seat, 'call', p_kind, 'of', g.last_seat,
                                                      'cards', to_jsonb(v_last), 'truth', v_truth, 'rank', g.claim_rank,
                                                      'taker', v_taker_seat, 'n', cardinality(g.pile), 'auto', coalesce(p_auto, false)));
  if v_taker is not null then
    update public.bluff_players x set hand = x.hand || g.pile where x.room_id = p_room and x.user_id = v_taker;
  else
    update public.bluff_rooms x set bita = x.bita + cardinality(g.pile) where x.id = p_room;
  end if;
  update public.bluff_rooms x set pile = '{}', claim_rank = null, last_seat = null, last_n = 0 where x.id = p_room;
  if v_taker is not null then perform public.bluff_fours(p_room, v_taker); end if;
  perform public.bluff_outs(p_room, null);              -- положивший последние карты (не забрал) и забравший, у кого всё ушло четвёрками
  if public.bluff_end_check(p_room) then return; end if;
  if (p_kind = 'doubt' and not v_truth) or (p_kind = 'trust' and v_truth) then
    v_start := me.seat;                                 -- угадал — начинает новый круг
    if exists (select 1 from public.bluff_players x where x.room_id = p_room and x.seat = v_start and x.place is not null) then
      v_start := public.bluff_next(p_room, v_start);
    end if;
  else
    v_start := public.bluff_next(p_room, me.seat);      -- ошибся — забрал стопку и пропускает ход
  end if;
  update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_move(bigint, uuid, text, integer[], integer, boolean) from public, anon, authenticated;

-- 7. Бот: у него одни джокеры — называет случайный номинал отрезка
create or replace function public.bluff_bot_move(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_rank integer; v_cards integer[]; v_k integer; v_j integer; v_roll double precision := random();
begin
  select * into g from public.bluff_rooms x where x.id = p_room;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if g.claim_rank is null then
    select c / 4 + 2 into v_rank from unnest(me.hand) c where c < 52 group by 1 order by count(*) desc, random() limit 1;
    if v_rank is null then                                   -- одни джокеры
      v_rank := g.low_rank + floor(random() * (g.high_rank - g.low_rank + 1))::integer;
      v_cards := me.hand[1:1];
    else
      v_cards := array(select c from unnest(me.hand) c where c < 52 and c / 4 + 2 = v_rank);
      if v_roll < 0.3 then
        v_cards := v_cards || array(select c from unnest(me.hand) c where not (c = any (v_cards)) order by random() limit 1);
      end if;
    end if;
    perform public.bluff_move(p_room, p_user, 'put', v_cards, v_rank, false);
    return;
  end if;
  select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  v_k := (select count(*) from unnest(me.hand) c where c < 52 and c / 4 + 2 = g.claim_rank);
  v_j := (select count(*) from unnest(me.hand) c where c >= 52);
  if v_k + g.last_n > 4 + g.jokers or (cardinality(v_prev.hand) = 0 and v_roll < 0.6) then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_k + v_j > 0 and v_roll < 0.7 then
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c where c >= 52 or c / 4 + 2 = g.claim_rank), null, false);
  elsif v_roll < 0.25 then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_roll < 0.45 then
    perform public.bluff_move(p_room, p_user, 'trust', null, null, false);
  else
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c order by random() limit 1 + floor(random() * 2)::integer), null, false);
  end if;
end $function$;
revoke all on function public.bluff_bot_move(bigint, uuid) from public, anon, authenticated;

-- 8. «Ещё раз» — та же колода
create or replace function public.bluff_rematch(p_room bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  v_id bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'finished'
     or not exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'bluff_gone';
  end if;
  if g.rematch_id is not null then
    perform public.bluff_tick(g.rematch_id);
    if exists (select 1 from public.bluff_players x where x.room_id = g.rematch_id and x.user_id = uid) then
      return g.rematch_id;
    end if;
    if exists (select 1 from public.bluff_rooms x where x.id = g.rematch_id and x.status = 'open') then
      perform public.bluff_enter(g.rematch_id, uid);
      update public.bluff_rooms x set version = x.version + 1 where x.id = p_room;
      return g.rematch_id;
    end if;
  end if;
  v_id := public.bluff_new(uid, g.stake, g.low_rank, g.high_rank, g.jokers, g.id, g.test);
  if g.test then
    insert into public.bluff_players (room_id, user_id, seat, stake, bot_name, ready)
    select v_id, x.user_id, row_number() over (order by x.seat)::integer, 0, x.bot_name, true
      from public.bluff_players x where x.room_id = p_room and x.bot_name is not null;
  end if;
  update public.bluff_rooms x set rematch_id = v_id, version = x.version + 1 where x.id = p_room;
  return v_id;
end $function$;
revoke all on function public.bluff_rematch(bigint) from public, anon;
grant execute on function public.bluff_rematch(bigint) to authenticated;

-- 9. Вид комнаты и список: поле high
create or replace function public.bluff_view(p_room bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_turn boolean;
  v_players jsonb; v_rematch jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if public.bluff_due(p_room) then perform public.bluff_tick(p_room); end if;
  select * into g from public.bluff_rooms x where x.id = p_room;
  if not found then raise exception 'bluff_gone'; end if;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  if not found then
    -- не игрок: открытую комнату можно посмотреть (кто в ней), чужую игру и тестовую комнату — нет
    if g.test or g.status not in ('open', 'ready', 'cancelled') then raise exception 'bluff_gone'; end if;
  end if;
  v_turn := g.status = 'play' and me.user_id is not null and me.place is null and me.seat = g.turn_seat;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'creator', x.user_id = g.creator, 'ready', x.ready,
           'n', cardinality(x.hand), 'misses', x.misses, 'place', x.place, 'out', x.out_kind, 'payout', x.payout
         ) order by x.seat)
    into v_players
    from public.bluff_players x left join public.profiles pr on pr.id = x.user_id
   where x.room_id = p_room;

  if g.rematch_id is not null then
    select jsonb_build_object('id', r.id, 'status', r.status,
             'in', exists (select 1 from public.bluff_players y where y.room_id = r.id and y.user_id = uid),
             'n', (select count(*) from public.bluff_players y where y.room_id = r.id))
      into v_rematch from public.bluff_rooms r where r.id = g.rematch_id and r.status in ('open', 'ready');
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'stake', g.stake, 'version', g.version, 'test', g.test,
    'low', g.low_rank, 'high', g.high_rank, 'jokers', g.jokers, 'deck_n', public.bluff_deck_n(g.low_rank, g.high_rank, g.jokers),
    'max_seats', least(6, public.bluff_deck_n(g.low_rank, g.high_rank, g.jokers)),
    'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'alone_ms', (extract(epoch from public.bluff_alone_at(g.id)) * 1000)::bigint,
    'turn', g.turn_seat, 'claim', g.claim_rank, 'pile_n', cardinality(g.pile), 'last_seat', g.last_seat, 'last_n', g.last_n,
    'bita', g.bita, 'log', g.log,
    'players', coalesce(v_players, '[]'),
    'rematch', v_rematch,
    'my', case when me.user_id is null then null else jsonb_build_object(
      'seat', me.seat, 'ready', me.ready, 'place', me.place, 'payout', me.payout, 'stake', me.stake,
      'hand', coalesce((select jsonb_agg(c order by (c >= 52), c) from unnest(me.hand) c), '[]'),
      'turn', v_turn,
      'new_round', v_turn and g.claim_rank is null,
      'can_call', v_turn and g.claim_rank is not null and g.last_seat is distinct from me.seat) end
  );
end $function$;
revoke all on function public.bluff_view(bigint) from public, anon;
grant execute on function public.bluff_view(bigint) to authenticated;

create or replace function public.bluff_list()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  r record;
  v jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select g.id from public.bluff_rooms g where g.status in ('open', 'ready', 'play') and public.bluff_due(g.id) loop
    perform public.bluff_tick(r.id);
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.created_at desc), '[]') into v from (
    select g.id, g.status, g.stake, g.test, g.low_rank as low, g.high_rank as high, g.jokers, g.created_at, g.finished_at,
           least(6, public.bluff_deck_n(g.low_rank, g.high_rank, g.jokers)) as max_seats,
           g.status in ('open', 'ready', 'play') as active,
           exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as mine,
           g.creator = uid as is_creator,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
                                                'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
                                                'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end,
                                                'place', x.place, 'payout', x.payout) order by x.seat)
              from public.bluff_players x left join public.profiles pr on pr.id = x.user_id where x.room_id = g.id) as players,
           (select x.place from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as my_place,
           (select x.payout from public.bluff_players x where x.room_id = g.id and x.user_id = uid) as my_payout
      from public.bluff_rooms g
     where (g.status in ('open', 'ready') and (not g.test or exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid)))
        or (g.status = 'play' and exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid
                                           and coalesce(x.out_kind, '') not in ('afk', 'left')))
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
revoke all on function public.bluff_list() from public, anon;
grant execute on function public.bluff_list() to authenticated;

-- 10. Старый подсчёт колоды (два числа) больше нигде не нужен
drop function public.bluff_deck_n(integer, integer);
