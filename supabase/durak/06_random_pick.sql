-- «ДУРАК»: если игрок не успел выбрать открытые карты, база кладёт открытыми три СЛУЧАЙНЫЕ из шести (раньше — три старшие).
-- Меняется только durak_tick (остальное — как в 02_bots.sql). Боты по-прежнему выбирают старшие сами при раздаче.

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
revoke all on function public.durak_tick(bigint) from public, anon, authenticated;
