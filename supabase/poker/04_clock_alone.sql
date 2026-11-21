-- ПОКЕР: снова время на ход — 1 минута; один за столом минуту — стол закрывается (21.11.2026).
-- Ставится после 01_poker.sql, 02_play_money.sql и 03_no_clock.sql.
-- 1. Время на ход — 60 секунд. Вышло — база делает чек (если можно) или пас; второй пропуск подряд — игрок встаёт,
--    фишки на баланс (как было до 03, только 60 секунд вместо 30). Боты по-прежнему ходят через 1,5 секунды.
-- 2. Если за столом на монеты сидит один человек (только что открыл, или остальные ушли) — через минуту стол
--    закрывается, его фишки уходят на баланс. Сел кто-то ещё — отсчёт пропадает. Стол с ботами это не трогает.
-- 3. Страховка из 03 остаётся: раздача без хода сутки (если расписание не работало) отменяется.

-- Когда закрыть стол, где сидит один человек: через минуту после того, как он остался один
-- (открыл стол или последний сосед ушёл). Не один, стол с ботами или идёт раздача — null.
create or replace function public.poker_alone_at(p_table bigint)
returns timestamptz
language sql stable security definer set search_path to ''
as $function$
  -- сесть за стол на монеты можно только к тому, кто уже сидит, поэтому «остался один» — это открытие стола или последний уход
  select greatest(g.created_at, (select max(x.left_at) from public.poker_seats x where x.table_id = g.id)) + interval '1 minute'
    from public.poker_tables g
   where g.id = p_table and not g.test and g.status = 'open'
     and (select count(*) from public.poker_seats x where x.table_id = g.id and x.left_at is null) = 1
$function$;
revoke all on function public.poker_alone_at(bigint) from public, anon, authenticated;

-- 11. После хода: кто следующий (на ход — 60 секунд), или круг окончен (выложить карты), или раздача окончена
create or replace function public.poker_advance(p_table bigint, p_from integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  v_live integer; v_can integer; v_owe boolean; v_seat integer; v_from integer := p_from; v_new integer[];
begin
  loop
    select * into g from public.poker_tables x where x.id = p_table;
    select count(*) filter (where not x.folded), count(*) filter (where not x.folded and not x.allin),
           coalesce(bool_or(not x.folded and not x.allin and x.bet < g.cur_bet), false)
      into v_live, v_can, v_owe
      from public.poker_seats x where x.table_id = p_table and x.in_hand;
    if v_live <= 1 then perform public.poker_finish(p_table); return; end if;
    -- ставить есть кому: двое и больше могут ходить, или один должен ответить на ставку
    if v_can >= 2 or v_owe then
      v_seat := public.poker_actor(p_table, v_from);
      if v_seat is not null then
        update public.poker_tables x set turn_seat = v_seat, deadline = now() + interval '60 seconds', version = x.version + 1 where x.id = p_table;
        return;
      end if;
    end if;
    -- круг ставок окончен: ставки уходят в банк
    update public.poker_seats x set bet = 0, acted = false,
           last_act = case when x.folded then 'fold' when x.allin then 'allin' end
     where x.table_id = p_table and x.in_hand;
    if g.street = 'river' then perform public.poker_finish(p_table); return; end if;
    -- первая карта колоды «сжигается», как за настоящим столом
    if g.street = 'pre' then v_new := g.deck[2:4]; g.deck := g.deck[5:];
    else v_new := g.deck[2:2]; g.deck := g.deck[3:]; end if;
    update public.poker_tables x
       set board = x.board || v_new, deck = g.deck, cur_bet = 0, min_raise = x.bb, turn_seat = null, deadline = null,
           street = case g.street when 'pre' then 'flop' when 'flop' then 'turn' else 'river' end
     where x.id = p_table;
    perform public.poker_log(p_table, jsonb_build_object('kind', 'street',
      'street', case g.street when 'pre' then 'flop' when 'flop' then 'turn' else 'river' end, 'cards', to_jsonb(v_new)));
    v_from := g.button_seat;   -- после флопа первым ходит первый слева от дилера
  end loop;
end $function$;

-- 16. Часы стола: ход бота, время хода вышло, пора начать раздачу, один за столом минуту, пустой или заброшенный стол
create or replace function public.poker_tick(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  p public.poker_seats%rowtype;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  if not found or g.status = 'closed' then return; end if;
  if g.status = 'play' then
    -- страховка: сутки никто не ходил (расписание не работало) — раздача отменяется, стол закрывается
    if g.deadline < now() - interval '24 hours' then perform public.poker_abandon(p_table); return; end if;
    select * into p from public.poker_seats x
     where x.table_id = p_table and x.left_at is null and x.seat = g.turn_seat and x.in_hand and not x.folded and not x.allin;
    if not found then perform public.poker_advance(p_table, coalesce(g.turn_seat, g.button_seat)); return; end if;
    -- бот ходит через 1,5 секунды после начала своего хода (ход длится 60 секунд)
    if p.bot_name is not null then
      if g.deadline - interval '58.5 seconds' <= now() then perform public.poker_bot_move(p_table, p.user_id); end if;
      return;
    end if;
    if g.deadline >= now() - interval '1 second' then return; end if;
    update public.poker_seats x set misses = x.misses + 1 where x.id = p.id;
    if p.misses + 1 >= 2 then
      perform public.poker_stand(p_table, p.id, 'afk');            -- второй пропуск подряд — встаёт из-за стола
    elsif g.cur_bet <= p.bet then
      perform public.poker_move(p_table, p.user_id, 'check', null, true);
    else
      perform public.poker_move(p_table, p.user_id, 'fold', null, true);
    end if;
  else
    if g.active_at < now() - interval '24 hours' then
      perform public.poker_close(p_table);
    elsif not exists (select 1 from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.bot_name is null) then
      perform public.poker_close_if_empty(p_table);              -- людей нет — раздач нет
    elsif public.poker_alone_at(p_table) <= now() then
      perform public.poker_log(p_table, jsonb_build_object('kind', 'alone'));   -- телефону: почему стол закрыт
      perform public.poker_close(p_table);                       -- один за столом минуту — стол закрывается
    elsif g.next_at is not null and g.next_at <= now() then
      perform public.poker_deal(p_table);
    end if;
  end if;
end $function$;

-- Пора ли трогать часы стола (вызывают вид, список и расписание)
create or replace function public.poker_due(p_table bigint)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.poker_tables g where g.id = p_table and (
           (g.status = 'play' and (g.deadline < now() - interval '1 second'
              or (g.deadline - interval '58.5 seconds' <= now()
                  and exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null
                              and x.seat = g.turn_seat and x.bot_name is not null))
              or not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null
                             and x.seat = g.turn_seat and x.in_hand and not x.folded and not x.allin)))
        or (g.status = 'open' and (g.next_at <= now() or g.active_at < now() - interval '24 hours'
              or public.poker_alone_at(g.id) <= now()
              or not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null and x.bot_name is null)))))
$function$;
revoke all on function public.poker_tick(bigint) from public, anon, authenticated;
revoke all on function public.poker_due(bigint) from public, anon, authenticated;

-- 19. Вид стола для телефона: + alone_ms — когда закроется стол, где сидит один человек
create or replace function public.poker_view(p_table bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.poker_tables%rowtype;
  me public.poker_seats%rowtype;
  v_last public.poker_seats%rowtype;
  v_players jsonb; v_pot numeric := 0; v_turn boolean := false; v_call numeric := 0; v_my jsonb; v_gone jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if public.poker_due(p_table) then perform public.poker_tick(p_table); end if;
  select * into g from public.poker_tables x where x.id = p_table;
  if not found then raise exception 'poker_gone'; end if;
  select * into me from public.poker_seats x where x.table_id = p_table and x.user_id = uid and x.left_at is null;
  if me.id is null then
    select * into v_last from public.poker_seats x where x.table_id = p_table and x.user_id = uid order by x.id desc limit 1;
    -- не сидит: открытый стол можно посмотреть; тестовый чужой и закрытый (где не сидел) — нет
    if (g.test and g.creator <> uid) or (g.status = 'closed' and v_last.id is null) then raise exception 'poker_gone'; end if;
    if v_last.id is not null and v_last.left_at > now() - interval '30 minutes' then
      v_gone := jsonb_build_object('kind', v_last.left_kind, 'cashout', v_last.cashout, 'net', v_last.cashout - v_last.buyin);
    end if;
  end if;

  if g.status = 'play' then
    select coalesce(sum(x.put - x.bet), 0) into v_pot from public.poker_seats x where x.table_id = p_table and x.in_hand;
  end if;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'stack', x.stack, 'bet', x.bet, 'in_hand', x.in_hand, 'folded', x.folded, 'allin', x.allin,
           'act', x.last_act,
           -- свои карты видно всегда, чужие — только открытые на вскрытии
           'cards', case when x.in_hand and (x.user_id = uid or g.shown ? x.seat::text) then to_jsonb(x.hole) end,
           'hidden', x.in_hand and not x.folded and x.user_id <> uid and not (g.shown ? x.seat::text) and cardinality(x.hole) = 2
         ) order by x.seat)
    into v_players
    from public.poker_seats x left join public.profiles pr on pr.id = x.user_id
   where x.table_id = p_table and x.left_at is null;

  if me.id is not null then
    v_turn := g.status = 'play' and me.in_hand and not me.folded and not me.allin and me.seat = g.turn_seat;
    v_call := least(greatest(g.cur_bet - me.bet, 0), me.stack);
    v_my := jsonb_build_object(
      'seat', me.seat, 'stack', me.stack, 'buyin', me.buyin, 'bet', me.bet, 'in_hand', me.in_hand, 'folded', me.folded, 'allin', me.allin,
      'hole', case when me.in_hand then to_jsonb(me.hole) end,
      'turn', v_turn, 'call', v_call,
      'can_check', v_turn and g.cur_bet <= me.bet,
      'can_raise', v_turn and not me.acted and me.stack > greatest(g.cur_bet - me.bet, 0),
      'min_to', least(g.cur_bet + g.min_raise, me.bet + me.stack), 'max_to', me.bet + me.stack,
      'can_topup', not (g.status = 'play' and me.in_hand and not me.folded) and me.stack < 100 * g.bb,
      'topup_max', greatest(100 * g.bb - me.stack, 0));
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'version', g.version, 'test', g.test, 'level', g.level, 'sb', g.sb, 'bb', g.bb,
    'min_buy', 40 * g.bb, 'max_buy', 100 * g.bb, 'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'next_ms', (extract(epoch from g.next_at) * 1000)::bigint,
    'alone_ms', (extract(epoch from public.poker_alone_at(g.id)) * 1000)::bigint,
    'hand', g.hand_no, 'street', g.street, 'board', to_jsonb(g.board), 'pot', v_pot, 'cur_bet', g.cur_bet,
    'button', g.button_seat, 'sb_seat', g.sb_seat, 'bb_seat', g.bb_seat, 'turn', case when g.status = 'play' then g.turn_seat end,
    'result', case when g.status = 'open' then g.result end,
    'log', g.log,
    'players', coalesce(v_players, '[]'),
    'my', v_my, 'gone', v_gone
  );
end $function$;
revoke all on function public.poker_view(bigint) from public, anon;
grant execute on function public.poker_view(bigint) to authenticated;
revoke all on function public.poker_advance(bigint, integer) from public, anon, authenticated;

-- Раздачи, которые идут прямо сейчас: у того, чей ход, — свежая минута; старые пропуски не считаются
update public.poker_seats x set misses = 0 where x.left_at is null and x.misses <> 0;
update public.poker_tables g set deadline = now() + interval '60 seconds' where g.status = 'play' and g.turn_seat is not null;
