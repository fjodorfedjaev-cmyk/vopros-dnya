-- ВЕРЮ — НЕ ВЕРЮ: «Наблюдать». Кто не играет, может смотреть идущую игру (и её итог): видно то же, что видят игроки, —
-- сколько у кого карт, сколько в стопке, названный номинал и карты, открытые при проверке; своей руки у наблюдателя нет
-- (my = null). Тестовые комнаты (с ботами) по-прежнему видит только админ.
-- Список комнат: идущие игры видны всем, у чужих — признак watch («Наблюдать»).
-- Меняются только bluff_view и bluff_list (взяты из 02_range.sql).

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
           -- «Наблюдать»: идёт игра, а я в ней не играю (или уже вышел)
           g.status = 'play' and not exists (select 1 from public.bluff_players x where x.room_id = g.id and x.user_id = uid
                                               and coalesce(x.out_kind, '') not in ('afk', 'left')) as watch,
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
        or (g.status = 'play' and not g.test)                                          -- идёт игра: остальные могут наблюдать
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
