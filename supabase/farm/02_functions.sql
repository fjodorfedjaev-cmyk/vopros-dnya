-- ФЕРМА, часть 2: функции. Все деньги (серебро) двигаются только здесь.
-- Каждая функция выполняется целиком как одна операция: либо всё получилось, либо ничего не изменилось.
-- Время всегда берёт сервер (clock_timestamp), часы телефона ни на что не влияют.

-- Внутренняя функция: проверяет, что это участник, берёт блокировку на игрока
-- (чтобы две одновременные операции шли по очереди) и создаёт кошелёк при первом заходе.
create function public.farm_enter()
returns public.farm_wallets
language plpgsql security definer set search_path = ''
as $$
declare
  w public.farm_wallets;
  v_start integer;
begin
  if auth.uid() is null or not public.is_member() then
    raise exception 'not_member';
  end if;
  perform pg_advisory_xact_lock(hashtext('farm:' || auth.uid()::text));

  insert into public.farm_wallets (user_id) values (auth.uid())
  on conflict (user_id) do nothing
  returning silver into v_start;
  if v_start is not null then
    insert into public.farm_log (user_id, kind, amount) values (auth.uid(), 'start', v_start);
  end if;

  select * into w from public.farm_wallets where user_id = auth.uid();
  return w;
end $$;

-- Состояние фермы для экрана: серебро, клетки, семена, цены, активные посадки.
create function public.farm_state()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.farm_wallets;
  v_now timestamptz := clock_timestamp();
begin
  w := public.farm_enter();
  return jsonb_build_object(
    'server_ms',  floor(extract(epoch from v_now) * 1000)::bigint,
    'silver',     w.silver,
    'plots_open', w.plots_open,
    'seeds', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'grow_seconds', s.grow_seconds,
               'cost', s.cost, 'payout', s.payout) order by s.sort), '[]'::jsonb)
        from public.farm_seeds s where s.active),
    'plot_prices', (
      select coalesce(jsonb_agg(p.price order by p.plot), '[]'::jsonb)
        from public.farm_plot_prices p),
    'plantings', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', f.id, 'plot', f.plot, 'seed_id', f.seed_id,
               'planted_ms', floor(extract(epoch from f.planted_at) * 1000)::bigint,
               'ready_ms',   floor(extract(epoch from f.ready_at) * 1000)::bigint,
               'cost', f.cost, 'payout', f.payout) order by f.plot), '[]'::jsonb)
        from public.farm_plantings f
       where f.user_id = auth.uid() and f.harvested_at is null)
  );
end $$;

-- Купить клетку. Передаём НОМЕР клетки, а не «купи следующую»:
-- если запрос придёт второй раз, это уже не следующая клетка, и он безопасно не пройдёт.
create function public.farm_buy_plot(p_plot integer)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.farm_wallets;
  v_price integer;
begin
  w := public.farm_enter();
  if p_plot is distinct from w.plots_open + 1 or w.plots_open >= 16 then
    raise exception 'not_next';
  end if;
  select price into v_price from public.farm_plot_prices where plot = p_plot;
  if v_price is null then raise exception 'no_price'; end if;
  if w.silver < v_price then raise exception 'not_enough'; end if;

  update public.farm_wallets
     set silver = silver - v_price, plots_open = p_plot
   where user_id = auth.uid();
  insert into public.farm_log (user_id, kind, amount, ref)
  values (auth.uid(), 'buy_plot', -v_price, p_plot::text);

  return jsonb_build_object('silver', w.silver - v_price, 'plots_open', p_plot, 'spent', v_price);
end $$;

-- Посадить семя на одну или несколько клеток. Всё или ничего:
-- если хоть одна клетка закрыта или занята, или не хватает серебра, не садится ничего.
create function public.farm_plant(p_seed text, p_plots integer[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.farm_wallets;
  s public.farm_seeds;
  v_now timestamptz := clock_timestamp();
  n integer;
  v_total integer;
begin
  w := public.farm_enter();

  select * into s from public.farm_seeds where id = p_seed and active;
  if not found then raise exception 'bad_seed'; end if;

  n := coalesce(cardinality(p_plots), 0);
  if n < 1 or n > 16 then raise exception 'bad_plots'; end if;
  if exists (select 1 from unnest(p_plots) x where x is null or x < 1 or x > w.plots_open) then
    raise exception 'plot_closed';
  end if;
  if (select count(distinct x) from unnest(p_plots) x) <> n then raise exception 'bad_plots'; end if;
  if exists (select 1 from public.farm_plantings f
              where f.user_id = auth.uid() and f.harvested_at is null and f.plot = any (p_plots)) then
    raise exception 'plot_busy';
  end if;

  v_total := s.cost * n;
  if w.silver < v_total then raise exception 'not_enough'; end if;

  -- цена, выплата и время готовности фиксируются в самой посадке
  insert into public.farm_plantings (user_id, plot, seed_id, planted_at, ready_at, cost, payout)
  select auth.uid(), x, s.id, v_now, v_now + make_interval(secs => s.grow_seconds), s.cost, s.payout
    from unnest(p_plots) x;

  if v_total > 0 then
    update public.farm_wallets set silver = silver - v_total where user_id = auth.uid();
    insert into public.farm_log (user_id, kind, amount, ref)
    values (auth.uid(), 'plant', -v_total, s.id);
  end if;

  return jsonb_build_object('silver', w.silver - v_total, 'planted', n, 'spent', v_total);
end $$;

-- Собрать урожай. Передаём id конкретных посадок; null = собрать всё готовое.
-- Собирается только то, что готово (ready_at <= сейчас) и ещё не собрано,
-- и отметка «собрано» ставится в том же действии, поэтому второй раз ту же посадку собрать нельзя.
create function public.farm_harvest(p_ids uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.farm_wallets;
  v_now timestamptz := clock_timestamp();
  v_gain integer;
  v_cost integer;
  v_cnt integer;
begin
  w := public.farm_enter();

  with done as (
    update public.farm_plantings f
       set harvested_at = v_now
     where f.user_id = auth.uid()
       and f.harvested_at is null
       and f.ready_at <= v_now
       and (p_ids is null or f.id = any (p_ids))
    returning f.payout, f.cost
  )
  select coalesce(sum(payout), 0), coalesce(sum(cost), 0), count(*)
    into v_gain, v_cost, v_cnt
    from done;

  if v_cnt > 0 then
    update public.farm_wallets set silver = silver + v_gain where user_id = auth.uid();
    insert into public.farm_log (user_id, kind, amount, ref)
    values (auth.uid(), 'harvest', v_gain, v_cnt::text);
  end if;

  return jsonb_build_object(
    'silver',    w.silver + v_gain,
    'gained',    v_gain,            -- вся выплата
    'profit',    v_gain - v_cost,   -- чистая прибыль (выплата минус ранее списанная цена)
    'harvested', v_cnt);
end $$;

-- Права: клиенты (вошедшие игроки) могут вызывать только эти четыре функции.
revoke all on function public.farm_enter() from public, anon, authenticated;
revoke all on function public.farm_state() from public, anon;
revoke all on function public.farm_buy_plot(integer) from public, anon;
revoke all on function public.farm_plant(text, integer[]) from public, anon;
revoke all on function public.farm_harvest(uuid[]) from public, anon;
grant execute on function public.farm_state() to authenticated;
grant execute on function public.farm_buy_plot(integer) to authenticated;
grant execute on function public.farm_plant(text, integer[]) to authenticated;
grant execute on function public.farm_harvest(uuid[]) to authenticated;
