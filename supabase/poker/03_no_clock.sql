-- ПОКЕР: время на ход не ограничено (20.11.2026). Ставится после 01_poker.sql и 02_play_money.sql.
-- Люди думают сколько хотят: по времени никто не пасует, не чекает и не встаёт из-за стола.
-- Боты ходят как раньше — через 1,5 секунды после начала своего хода.
-- Страховка: если в раздаче сутки никто не ходил (игрок закрыл приложение и не вернулся) — раздача отменяется:
-- каждому возвращается то, что он поставил в этой раздаче, стол закрывается, фишки уходят на баланс.
-- deadline теперь не срок хода, а отметка «ход начался + 30 секунд» (по ней ходят боты и считаются сутки); столбец misses больше не растёт.

-- Отменить раздачу и закрыть стол: поставленное в раздаче — обратно (сидящим — в фишки, ушедшим посреди раздачи — к унесённому)
create or replace function public.poker_abandon(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.poker_seats x
     set stack = case when x.left_at is null then x.stack + x.put else x.stack end,
         cashout = case when x.left_at is null then x.cashout else coalesce(x.cashout, 0) + x.put end,
         put = 0, bet = 0
   where x.table_id = p_table and x.in_hand and x.put > 0;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'abandon'));
  perform public.poker_close(p_table);
end $function$;
revoke all on function public.poker_abandon(bigint) from public, anon, authenticated;

-- 16. Часы стола: ход бота, пора начать раздачу, пустой или заброшенный стол (человека по времени не трогаем)
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
    -- сутки никто не ходил — раздача отменяется, стол закрывается
    if g.deadline < now() - interval '24 hours' then perform public.poker_abandon(p_table); return; end if;
    select * into p from public.poker_seats x
     where x.table_id = p_table and x.left_at is null and x.seat = g.turn_seat and x.in_hand and not x.folded and not x.allin;
    if not found then perform public.poker_advance(p_table, coalesce(g.turn_seat, g.button_seat)); return; end if;
    -- бот ходит через 1,5 секунды после начала своего хода; человек думает сколько хочет
    if p.bot_name is not null and g.deadline - interval '28.5 seconds' <= now() then
      perform public.poker_bot_move(p_table, p.user_id);
    end if;
  else
    if g.active_at < now() - interval '24 hours' then
      perform public.poker_close(p_table);
    elsif not exists (select 1 from public.poker_seats x where x.table_id = p_table and x.left_at is null and x.bot_name is null) then
      perform public.poker_close_if_empty(p_table);              -- людей нет — раздач нет
    elsif g.next_at is not null and g.next_at <= now() then
      perform public.poker_deal(p_table);
    end if;
  end if;
end $function$;

-- Пора ли трогать часы стола (вызывают вид, список и расписание): ход бота, сутки без хода, пора раздавать, стол брошен
create or replace function public.poker_due(p_table bigint)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.poker_tables g where g.id = p_table and (
           (g.status = 'play' and (g.deadline < now() - interval '24 hours'
              or (g.deadline - interval '28.5 seconds' <= now()
                  and exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null
                              and x.seat = g.turn_seat and x.bot_name is not null))
              or not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null
                             and x.seat = g.turn_seat and x.in_hand and not x.folded and not x.allin)))
        or (g.status = 'open' and (g.next_at <= now() or g.active_at < now() - interval '24 hours'
              or not exists (select 1 from public.poker_seats x where x.table_id = g.id and x.left_at is null and x.bot_name is null)))))
$function$;
