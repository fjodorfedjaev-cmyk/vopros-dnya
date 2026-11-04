-- История казино: в «Сапёре» не показываем ставки, забранные сразу (возврат без открытых клеток).
-- Фильтр стоит в базе, поэтому их не покажет и старая версия сайта, сохранённая в кэше телефона.
-- Сами записи в casino_rounds остаются как есть.

create or replace function public.casino_history(p_game text, p_limit integer default 10)
returns table (game text, bet numeric, payout numeric, state text, info jsonb, finished_at timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select r.game, r.bet, r.payout, r.state,
         r.info || case when r.game = 'crash' then jsonb_build_object('crash', r.secret -> 'crash') else '{}'::jsonb end,
         r.finished_at
  from public.casino_rounds r
  where r.user_id = auth.uid() and r.state <> 'active' and r.game = p_game and public.is_member()
    and not (r.game = 'mines' and r.state = 'refund')
  order by r.finished_at desc
  limit least(greatest(p_limit, 1), 30)
$function$;
