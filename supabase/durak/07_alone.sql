-- ДУРАК: один в комнате минуту — комната закрывается (21.11.2026), как стол в Покере (poker_04_clock_alone).
-- Ставится после 01_durak.sql … 06_random_pick.sql.
-- Ушедшие из открытой комнаты удаляются из durak_players, поэтому момент «остался один» база запоминает сама:
-- столбец durak_rooms.alone_since ставит триггер на durak_players при каждом входе и выходе
-- (людей в комнате ровно один — с этого момента; двое и больше или никого — пусто).
-- Через минуту после alone_since открытая комната закрывается (как при выходе последнего): ставка возвращается.
-- Новая комната (и «Ещё раз») тоже. Тестовые комнаты с ботами это не трогает. Телефону — alone_ms в durak_view.

alter table public.durak_rooms add column if not exists alone_since timestamptz;   -- с какого момента в комнате один человек

-- Триггер: после входа и выхода пересчитать, один ли человек в комнате (боты не считаются)
create or replace function public.durak_alone_mark()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare r bigint;
begin
  if tg_op = 'DELETE' then r := old.room_id; else r := new.room_id; end if;
  update public.durak_rooms g
     set alone_since = case when (select count(*) from public.durak_players x where x.room_id = r and x.bot_name is null) = 1
                            then coalesce(g.alone_since, now()) else null end
   where g.id = r;
  return null;
end $function$;
revoke all on function public.durak_alone_mark() from public, anon, authenticated;
drop trigger if exists durak_players_alone on public.durak_players;
create trigger durak_players_alone after insert or delete on public.durak_players
  for each row execute function public.durak_alone_mark();

-- Когда закрыть комнату, где один человек: через минуту после alone_since. Не открыта, тестовая или не один — null.
create or replace function public.durak_alone_at(p_room bigint)
returns timestamptz
language sql stable security definer set search_path to ''
as $function$
  select g.alone_since + interval '1 minute' from public.durak_rooms g
   where g.id = p_room and g.status = 'open' and not g.test and g.alone_since is not null
$function$;
revoke all on function public.durak_alone_at(bigint) from public, anon, authenticated;

-- Комнаты, которые уже открыты: один человек — «один с тех пор, как зашёл» (кто ждёт дольше минуты — комната закроется)
update public.durak_rooms g
   set alone_since = (select max(x.joined_at) from public.durak_players x where x.room_id = g.id and x.bot_name is null)
 where g.status in ('open', 'ready')
   and (select count(*) from public.durak_players x where x.room_id = g.id and x.bot_name is null) = 1;

-- Часы комнаты: + один в комнате минуту — закрыть
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
    if g.created_at < now() - interval '24 hours'
       or not exists (select 1 from public.durak_players x where x.room_id = g.id and x.bot_name is null) then
      perform public.durak_cancel_room(g.id);
    elsif public.durak_alone_at(g.id) <= now() then
      -- один в комнате минуту — комната закрывается, ставка возвращается (телефону в журнал: почему)
      perform public.durak_log(g.id, jsonb_build_object('kind', 'alone'));
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
    -- не выбрали — открытыми кладутся три случайные из шести, остальные три — в руку
    update public.durak_players x
       set open = array(select y from unnest(x.pick) y order by random() limit 3)
     where x.room_id = g.id and not x.chosen;
    update public.durak_players x
       set hand = array(select y from unnest(x.pick) y where y <> all (x.open)), pick = '{}', chosen = true
     where x.room_id = g.id and not x.chosen;
    perform public.durak_begin(g.id);

  elsif g.status = 'play' then
    select * into p from public.durak_players x where x.room_id = g.id and x.seat = g.turn_seat and x.place is null;
    -- ход бота: через 1,5 секунды после начала хода (ход длится 30 секунд, срок = начало + 30)
    if found and p.bot_name is not null then
      if g.deadline - interval '28.5 seconds' <= now() then
        perform public.durak_bot_move(g.id, p.user_id);
      end if;
      return;
    end if;
    if g.deadline >= now() - interval '2 seconds' then return; end if;
    if p.user_id is null then
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

-- Вид комнаты: + alone_ms (когда закроется комната, где один человек); один дольше минуты — сначала часы комнаты
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
    -- не игрок: открытую комнату можно посмотреть (кто в ней), чужую игру и тестовую комнату — нет
    if g.test or g.status not in ('open', 'ready', 'cancelled') then raise exception 'durak_gone'; end if;
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

-- Список комнат: + один в комнате минуту — закрыть при показе списка
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
                    or public.durak_alone_at(g.id) <= now()
                    or not exists (select 1 from public.durak_players x where x.room_id = g.id and x.bot_name is null)))
              or (g.status in ('ready', 'choose', 'play') and g.deadline < now() - interval '2 seconds') loop
    perform public.durak_tick(r.id);
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.created_at desc), '[]') into v from (
    select g.id, g.status, g.stake, g.test, g.created_at, g.finished_at,
           g.status in ('open', 'ready', 'choose', 'play') as active,
           exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid) as mine,
           g.creator = uid as is_creator,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
                                                'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
                                                'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end,
                                                'place', x.place, 'payout', x.payout) order by x.seat)
              from public.durak_players x left join public.profiles pr on pr.id = x.user_id where x.room_id = g.id) as players,
           (select x.place from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_place,
           (select x.payout from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_payout
      from public.durak_rooms g
     where (g.status in ('open', 'ready') and (not g.test or exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid)))
        or (g.status in ('choose', 'play') and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid
                                                          and coalesce(x.out_kind, '') not in ('afk', 'left')))   -- вышел — игра больше не «твоя»
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
revoke all on function public.durak_tick(bigint) from public, anon, authenticated;
revoke all on function public.durak_view(bigint) from public, anon;
grant execute on function public.durak_view(bigint) to authenticated;
revoke all on function public.durak_list() from public, anon;
grant execute on function public.durak_list() to authenticated;
