-- «ПОКЕР»: игра с ботами — на ненастоящие фишки, которых бесконечно много.
--
-- Простыми словами:
-- * Стол с ботами (тестовый, только у админа) и раньше не трогал монеты: места за ним помечены test и в баланс не идут.
-- * Теперь, если за таким столом у человека кончились фишки, он не встаёт из-за стола, а сразу получает ещё 100 больших блайндов
--   (как боты). В журнал пишется «rebuy» — телефон покажет, что фишки выдали.
-- * За обычными столами (на монеты) всё как было: фишки кончились — встаёшь.
-- Меняется только итог раздачи (poker_finish).

create or replace function public.poker_finish(p_table bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.poker_tables%rowtype;
  v_live integer; v_total numeric; v_prev numeric := 0; v_lvl numeric; v_top numeric; v_amt numeric; v_share numeric;
  v_rem integer; v_best integer; v_win integer[]; v_seat integer; i integer;
  v_pots jsonb := '[]'; v_won jsonb := '{}'; v_shown jsonb := '{}';
  v_bseat integer; v_p1 numeric; v_p2 numeric; v_live1 boolean; v_back numeric := 0; v_show numeric; v_winmap jsonb;
begin
  select * into g from public.poker_tables x where x.id = p_table for update;
  select count(*) into v_live from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
  select coalesce(sum(x.put), 0) into v_total from public.poker_seats x where x.table_id = p_table and x.in_hand;
  -- возврат: часть ставки того, кто поставил больше всех, которую никто не уравнял (это не выигрыш)
  select x.seat, x.put, not x.folded into v_bseat, v_p1, v_live1
    from public.poker_seats x where x.table_id = p_table and x.in_hand order by x.put desc, x.folded limit 1;
  select coalesce(max(x.put), 0) into v_p2
    from public.poker_seats x where x.table_id = p_table and x.in_hand and x.seat <> v_bseat;
  if v_live1 and v_p1 > v_p2 then v_back := v_p1 - v_p2; end if;
  if v_live = 1 then
    -- остальные спасовали: весь банк одному, карты не открываются
    select x.seat into v_seat from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
    v_won := jsonb_build_object(v_seat::text, v_total);
    v_pots := jsonb_build_array(jsonb_build_object('amount', v_total - v_back, 'seats', jsonb_build_array(v_seat)));
  elsif v_live > 1 then
    select max(x.put) into v_top from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
    for v_lvl in select distinct x.put from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded order by 1 loop
      -- банк этого уровня: с каждого (и спасовавших) — сколько он положил между прошлым уровнем и этим; последний забирает и всё, что выше
      select coalesce(sum(least(x.put, case when v_lvl = v_top then x.put else v_lvl end) - least(x.put, v_prev)), 0) into v_amt
        from public.poker_seats x where x.table_id = p_table and x.in_hand;
      v_prev := v_lvl;
      continue when v_amt <= 0;
      select max(public.poker_eval(x.hole || g.board)) into v_best
        from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded and x.put >= v_lvl;
      v_win := array(select x.seat from public.poker_seats x
                      where x.table_id = p_table and x.in_hand and not x.folded and x.put >= v_lvl and public.poker_eval(x.hole || g.board) = v_best
                      order by public.poker_after(g.button_seat, x.seat));
      v_share := trunc(v_amt / cardinality(v_win), 2);
      v_rem := round((v_amt - v_share * cardinality(v_win)) * 100)::integer;   -- лишние копейки — первым слева от дилера
      for i in 1..cardinality(v_win) loop
        v_won := jsonb_set(v_won, array[v_win[i]::text],
                           to_jsonb(coalesce((v_won ->> v_win[i]::text)::numeric, 0) + v_share + case when i <= v_rem then 0.01 else 0 end));
      end loop;
      -- на экране возврат не показываем как банк
      v_show := v_amt - case when v_lvl = v_top and cardinality(v_win) = 1 and v_win[1] = v_bseat then v_back else 0 end;
      if v_show > 0 then
        v_pots := v_pots || jsonb_build_array(jsonb_build_object('amount', v_show, 'seats', to_jsonb(v_win), 'name', public.poker_name(v_best)));
      end if;
    end loop;
    select coalesce(jsonb_object_agg(x.seat::text, to_jsonb(x.hole)), '{}') into v_shown
      from public.poker_seats x where x.table_id = p_table and x.in_hand and not x.folded;
  end if;

  select coalesce(jsonb_object_agg(k.key, k.value::numeric - case when k.key = v_bseat::text then v_back else 0 end), '{}') into v_winmap
    from jsonb_each_text(v_won) k where k.value::numeric - case when k.key = v_bseat::text then v_back else 0 end > 0;
  update public.poker_seats x set stack = x.stack + coalesce((v_won ->> x.seat::text)::numeric, 0)
   where x.table_id = p_table and x.in_hand and not x.folded;
  update public.poker_seats x set hands = x.hands + 1, last_act = null where x.table_id = p_table and x.in_hand;
  update public.poker_tables x
     set status = 'open', street = 'show', turn_seat = null, deadline = null, shown = v_shown,
         -- won — сколько фишек вернулось игроку (с возвратом), win — сколько он выиграл (без возврата)
         result = jsonb_build_object('hand', g.hand_no, 'pots', v_pots, 'won', v_won, 'showdown', v_live > 1,
                                     'back', case when v_back > 0 then jsonb_build_object(v_bseat::text, v_back) else '{}'::jsonb end,
                                     'win', v_winmap),
         next_at = now() + case when v_live > 1 then interval '6 seconds' else interval '3 seconds' end
   where x.id = p_table;
  perform public.poker_log(p_table, jsonb_build_object('kind', 'win', 'hand', g.hand_no, 'won', v_won, 'win', v_winmap, 'pots', v_pots, 'shown', v_shown));

  -- фишки кончились. За столом с ботами (игра на ненастоящие фишки) — всем сразу ещё 100 ББ (людям — с отметкой в журнале,
  -- телефон покажет «выдали ещё»). За обычным столом человек встаёт (может сесть снова).
  if g.test then
    for v_seat in select x.seat from public.poker_seats x
                   where x.table_id = p_table and x.left_at is null and x.stack = 0 and x.bot_name is null loop
      perform public.poker_log(p_table, jsonb_build_object('kind', 'rebuy', 'seat', v_seat, 'amount', 100 * g.bb));
    end loop;
    update public.poker_seats x set stack = 100 * g.bb, buyin = x.buyin + 100 * g.bb
     where x.table_id = p_table and x.left_at is null and x.stack = 0;
  end if;
  update public.poker_seats x set cashout = 0, left_at = now(), left_kind = 'bust'
   where x.table_id = p_table and x.left_at is null and x.stack = 0;
  perform public.poker_close_if_empty(p_table);
end $function$;
revoke all on function public.poker_finish(bigint) from public, anon, authenticated;
