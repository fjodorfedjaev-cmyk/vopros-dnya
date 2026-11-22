-- СОЗДАТЕЛЬ СТОЛА в карточных играх (22.11.2026).
--
-- Дурак и «Верю — не верю» (у создателя — кнопка «Начать»):
-- * У комнаты есть изначальный создатель (новый столбец owner). Он остаётся создателем, пока он в комнате и на месте.
-- * «На месте» — комната открыта у него на экране: телефон спрашивает комнату раз в секунду, база запоминает,
--   когда спрашивал (таблица card_seen). Не спрашивал больше 5 секунд (закрыл приложение, ушёл в другой раздел) —
--   создатель тот, кто зашёл в комнату следующим и сейчас на месте, и так далее. Вернулся — снова создатель.
-- * «Выйти» из комнаты — уход насовсем: изначальным становится тот, кто зашёл следующим.
-- * «Начать» нажал создатель — он и остаётся изначальным для «Ещё раз»: новая комната запоминает его,
--   и когда он туда зайдёт, создатель — он (раньше создателем «Ещё раз» становился тот, кто нажал первым).
-- * Столбец creator по-прежнему — «кто создатель сейчас»: его пересчитывает вид комнаты (durak_view, bluff_view)
--   и «Начать». Поменялся — растёт version, телефоны перерисовывают комнату.
--
-- Покер (у создателя нет кнопок, только название стола в списке): создатель встал из-за стола — создатель тот,
-- кто сел следующим (из тех, кто ещё за столом). Тестовые столы не трогает.
--
-- Новое: таблица card_seen, столбцы durak_rooms.owner и bluff_rooms.owner, функции card_seen_mark,
-- durak_host / bluff_host, durak_host_sync / bluff_host_sync, триггеры владельца и покерный триггер.
-- Меняются: durak_view (взята из 08_watch.sql), bluff_view (из 03_watch.sql), durak_start (из 02_bots.sql),
-- bluff_start (из 01_bluff.sql).

-- 1. Кто когда смотрел открытую комнату
create table public.card_seen (
  game text not null check (game in ('durak', 'bluff')),
  room_id bigint not null,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  primary key (game, room_id, user_id)
);
alter table public.card_seen enable row level security;
revoke all on public.card_seen from anon, authenticated;

create or replace function public.card_seen_mark(p_game text, p_room bigint, p_user uuid)
returns void
language sql security definer set search_path to ''
as $function$
  insert into public.card_seen (game, room_id, user_id, seen_at) values (p_game, p_room, p_user, now())
  on conflict (game, room_id, user_id) do update set seen_at = excluded.seen_at
$function$;
revoke all on function public.card_seen_mark(text, bigint, uuid) from public, anon, authenticated;

-- 2. Изначальный создатель
alter table public.durak_rooms add column owner uuid;
alter table public.bluff_rooms add column owner uuid;
update public.durak_rooms set owner = creator;
update public.bluff_rooms set owner = creator;

-- новая комната: изначальный — создатель; «Ещё раз» — изначальный прошлой комнаты
create or replace function public.durak_owner_new()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  new.owner := coalesce(new.owner, (select r.owner from public.durak_rooms r where r.id = new.rematch_of), new.creator);
  return new;
end $function$;
revoke all on function public.durak_owner_new() from public, anon, authenticated;
create trigger durak_rooms_owner before insert on public.durak_rooms
  for each row execute function public.durak_owner_new();

create or replace function public.bluff_owner_new()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  new.owner := coalesce(new.owner, (select r.owner from public.bluff_rooms r where r.id = new.rematch_of), new.creator);
  return new;
end $function$;
revoke all on function public.bluff_owner_new() from public, anon, authenticated;
create trigger bluff_rooms_owner before insert on public.bluff_rooms
  for each row execute function public.bluff_owner_new();

-- изначальный вышел из комнаты до игры («Выйти», не успел «Готов») — изначальным становится зашедший следующим
create or replace function public.durak_owner_left()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v uuid;
begin
  select x.user_id into v from public.durak_players x
   where x.room_id = old.room_id and x.bot_name is null order by x.joined_at, x.user_id limit 1;
  if v is not null then
    update public.durak_rooms g set owner = v
     where g.id = old.room_id and g.owner = old.user_id and g.status in ('open', 'ready');
  end if;
  return null;
end $function$;
revoke all on function public.durak_owner_left() from public, anon, authenticated;
create trigger durak_players_owner after delete on public.durak_players
  for each row execute function public.durak_owner_left();

create or replace function public.bluff_owner_left()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v uuid;
begin
  select x.user_id into v from public.bluff_players x
   where x.room_id = old.room_id and x.bot_name is null order by x.joined_at, x.user_id limit 1;
  if v is not null then
    update public.bluff_rooms g set owner = v
     where g.id = old.room_id and g.owner = old.user_id and g.status in ('open', 'ready');
  end if;
  return null;
end $function$;
revoke all on function public.bluff_owner_left() from public, anon, authenticated;
create trigger bluff_players_owner after delete on public.bluff_players
  for each row execute function public.bluff_owner_left();

-- 3. Кто создатель сейчас: сначала те, кто на месте (смотрел комнату за последние 5 секунд; p_here — тот, кто
-- спрашивает прямо сейчас; только что зашедший — тоже на месте), среди них — изначальный, потом по времени входа.
-- На месте никого — изначальный (если он в комнате), иначе зашедший раньше всех. Боты создателями не бывают.
create or replace function public.durak_host(p_room bigint, p_here uuid default null)
returns uuid
language sql stable security definer set search_path to ''
as $function$
  select x.user_id
    from public.durak_players x
    join public.durak_rooms g on g.id = x.room_id
    left join public.card_seen s on s.game = 'durak' and s.room_id = x.room_id and s.user_id = x.user_id
   where x.room_id = p_room and x.bot_name is null
   order by (x.user_id = p_here or greatest(s.seen_at, x.joined_at) > now() - interval '5 seconds') is true desc,
            (x.user_id = g.owner) is true desc, x.joined_at, x.user_id
   limit 1
$function$;
revoke all on function public.durak_host(bigint, uuid) from public, anon, authenticated;

create or replace function public.bluff_host(p_room bigint, p_here uuid default null)
returns uuid
language sql stable security definer set search_path to ''
as $function$
  select x.user_id
    from public.bluff_players x
    join public.bluff_rooms g on g.id = x.room_id
    left join public.card_seen s on s.game = 'bluff' and s.room_id = x.room_id and s.user_id = x.user_id
   where x.room_id = p_room and x.bot_name is null
   order by (x.user_id = p_here or greatest(s.seen_at, x.joined_at) > now() - interval '5 seconds') is true desc,
            (x.user_id = g.owner) is true desc, x.joined_at, x.user_id
   limit 1
$function$;
revoke all on function public.bluff_host(bigint, uuid) from public, anon, authenticated;

-- Записать создателя в комнату (только открытую). Поменялся — true.
create or replace function public.durak_host_sync(p_room bigint, p_here uuid default null)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare v uuid;
begin
  v := public.durak_host(p_room, p_here);
  if v is null then return false; end if;
  update public.durak_rooms g set creator = v, version = g.version + 1
   where g.id = p_room and g.status = 'open' and g.creator is distinct from v;
  return found;
end $function$;
revoke all on function public.durak_host_sync(bigint, uuid) from public, anon, authenticated;

create or replace function public.bluff_host_sync(p_room bigint, p_here uuid default null)
returns boolean
language plpgsql security definer set search_path to ''
as $function$
declare v uuid;
begin
  v := public.bluff_host(p_room, p_here);
  if v is null then return false; end if;
  update public.bluff_rooms g set creator = v, version = g.version + 1
   where g.id = p_room and g.status = 'open' and g.creator is distinct from v;
  return found;
end $function$;
revoke all on function public.bluff_host_sync(bigint, uuid) from public, anon, authenticated;

-- 4. Вид комнаты: отметить, что игрок на месте, и пересчитать создателя
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
                or (g.status = 'open' and (g.created_at < now() - interval '24 hours' or public.durak_alone_at(g.id) <= now()))
                or (g.status = 'play' and g.deadline - interval '28.5 seconds' <= now()
                    and exists (select 1 from public.durak_players x where x.room_id = g.id and x.seat = g.turn_seat and x.bot_name is not null))) then
    perform public.durak_tick(p_room);
    select * into g from public.durak_rooms x where x.id = p_room;
  end if;
  if not found then raise exception 'durak_gone'; end if;
  select * into me from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  if not found then
    -- не игрок: можно посмотреть любую комнату и наблюдать за игрой; тестовую (с ботами) — нет
    if g.test then raise exception 'durak_gone'; end if;
  end if;
  -- создатель: кто на месте (смотрит комнату), тот и создатель — изначальный первым
  if g.status = 'open' then
    if public.durak_host_sync(p_room, me.user_id) then
      select * into g from public.durak_rooms x where x.id = p_room;
    end if;
  end if;
  if me.user_id is not null and g.status in ('open', 'ready') then perform public.card_seen_mark('durak', p_room, uid); end if;

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
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'creator', x.user_id = g.creator, 'ready', x.ready, 'chosen', x.chosen,
           'hand', cardinality(x.hand),
           -- открытые карты видны, как только игрок их выбрал (во время выбора) и всю игру
           'open', case when g.status in ('play', 'finished') or (g.status = 'choose' and x.chosen) then to_jsonb(x.open) end,
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
    'id', g.id, 'status', g.status, 'stake', g.stake, 'version', g.version, 'test', g.test,
    'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'alone_ms', (extract(epoch from public.durak_alone_at(g.id)) * 1000)::bigint,
    'turn', g.turn_seat, 'need', v_need, 'pile_top', to_jsonb(v_top), 'pile_n', cardinality(g.pile),
    'deck_n', cardinality(g.deck), 'bita', g.bita,
    -- закрытая карта, которая не подошла, уходит в руку: её видит только тот, кто её открыл
    'log', coalesce((select jsonb_agg(case when t.e->>'kind' = 'flip_take' and (t.e->>'seat')::int is distinct from me.seat
                                           then t.e - 'cards' else t.e end order by t.n)
                       from jsonb_array_elements(g.log) with ordinality t(e, n)), '[]'),
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
    -- не игрок: можно посмотреть любую комнату и наблюдать за игрой; тестовую (с ботами) — нет
    if g.test then raise exception 'bluff_gone'; end if;
  end if;
  -- создатель: кто на месте (смотрит комнату), тот и создатель — изначальный первым
  if g.status = 'open' then
    if public.bluff_host_sync(p_room, me.user_id) then
      select * into g from public.bluff_rooms x where x.id = p_room;
    end if;
  end if;
  if me.user_id is not null and g.status in ('open', 'ready') then perform public.card_seen_mark('bluff', p_room, uid); end if;
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

-- 5. «Начать»: может только создатель (пересчитывается в этот момент); нажал — он изначальный для «Ещё раз»
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
  perform public.durak_host_sync(p_room, uid);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' or g.creator <> uid then raise exception 'durak_gone'; end if;
  update public.durak_rooms x set owner = uid where x.id = p_room;
  if (select count(*) from public.durak_players x where x.room_id = p_room) < 2 then raise exception 'durak_alone'; end if;
  update public.durak_players x set ready = (x.user_id = uid or x.bot_name is not null) where x.room_id = p_room;
  update public.durak_rooms x set status = 'ready', deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.ready) then
    perform public.durak_deal(p_room);
  elsif not g.test and exists (select 1 from public.push_subscriptions ps join public.durak_players x on x.user_id = ps.user_id
             where x.room_id = p_room and x.user_id <> uid and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', p_room, 'event', 'start'));
  end if;
end $function$;
revoke all on function public.durak_start(bigint) from public, anon;
grant execute on function public.durak_start(bigint) to authenticated;

create or replace function public.bluff_start(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  perform public.bluff_host_sync(p_room, uid);
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' or g.creator <> uid then raise exception 'bluff_gone'; end if;
  update public.bluff_rooms x set owner = uid where x.id = p_room;
  if (select count(*) from public.bluff_players x where x.room_id = p_room) < 3 then raise exception 'bluff_few'; end if;
  update public.bluff_players x set ready = (x.user_id = uid or x.bot_name is not null) where x.room_id = p_room;
  update public.bluff_rooms x set status = 'ready', deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.bluff_players x where x.room_id = p_room and not x.ready) then
    perform public.bluff_deal(p_room);
  end if;
end $function$;
revoke all on function public.bluff_start(bigint) from public, anon;
grant execute on function public.bluff_start(bigint) to authenticated;

-- 6. Покер: создатель встал из-за стола — создатель тот, кто сел следующим (из оставшихся людей)
create or replace function public.poker_creator_left()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare v uuid;
begin
  select x.user_id into v from public.poker_seats x
   where x.table_id = new.table_id and x.left_at is null and x.bot_name is null order by x.joined_at, x.id limit 1;
  if v is not null then
    update public.poker_tables g set creator = v where g.id = new.table_id and g.creator = new.user_id and not g.test;
  end if;
  return null;
end $function$;
revoke all on function public.poker_creator_left() from public, anon, authenticated;
create trigger poker_seats_creator after update of left_at on public.poker_seats
  for each row when (old.left_at is null and new.left_at is not null) execute function public.poker_creator_left();
