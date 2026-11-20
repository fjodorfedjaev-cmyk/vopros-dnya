-- МИНИ-ПРОФИЛЬ УЧАСТНИКА: всё для окна «нажал на человека» одним запросом. Только чтение, ничего не меняет.
--
-- Что отдаёт (jsonb):
-- * кто: имя, цвет, аватарка, знак зодиака, с какого дня с нами;
-- * серия (и лучшая), сколько ответов, ответил ли сегодня (сам ответ — нет: чтобы не увидеть его раньше своего), реакций на ответы;
-- * монеты (как в таблице «Участники» — coins_of);
-- * карточки: сколько разных собрано, сколько всего в серии, витрина (3 полки, уже с рисунком и названием);
-- * игры: рекорд Сектора и Зигзага за всё время, дуэли (победы / поражения / ничьи), Дурак (партий и сколько раз вышел первым,
--   тестовые комнаты с ботами не считаются);
-- * «между вами»: счёт дуэлей того, кто смотрит, с этим человеком (для своего профиля — пусто).
-- Видят только участники (is_member), как и остальную статистику.

create or replace function public.member_profile(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  me uuid := auth.uid();
  p public.profiles%rowtype;
  st record;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into p from public.profiles x where x.id = p_user;
  if not found then return null; end if;
  select s.current_streak, s.best_streak, s.total_answers, s.answered_today, s.reactions_received
    into st from public.member_stats() s where s.user_id = p_user;
  return jsonb_build_object(
    'user_id', p.id, 'name', p.display_name, 'color', p.color, 'avatar', p.avatar, 'zodiac', p.zodiac, 'joined', p.created_at,
    'streak', coalesce(st.current_streak, 0), 'best_streak', coalesce(st.best_streak, 0),
    'answers', coalesce(st.total_answers, 0), 'answered_today', coalesce(st.answered_today, false),
    'reactions', coalesce(st.reactions_received, 0),
    'coins', public.coins_of(p_user),
    'cards', (select count(distinct k.card_id)::integer from public.card_copies k where k.owner_id = p_user and k.state = 'owned'),
    'cards_total', (select count(*)::integer from public.cards),
    'shelf', coalesce((
      select jsonb_agg(jsonb_build_object('card_id', c.id, 'code', c.code, 'name', c.name, 'rarity', c.rarity,
                                          'copies', c.copies, 'serial', k.serial) order by sc.slot)
      from public.card_showcase sc
      join public.card_copies k on k.id = sc.copy_id
      join public.cards c on c.id = k.card_id
      where sc.user_id = p_user), '[]'::jsonb),
    'sector_best', (select max(g.score) from public.game_sessions g where g.user_id = p_user and g.game = 'sector' and g.valid),
    'zigzag_best', (select max(z.score) from public.zigzag_sessions z where z.user_id = p_user and z.valid),
    'duels', (
      select jsonb_build_object(
        'won', count(*) filter (where (d.result = 'p1' and d.p1 = p_user) or (d.result = 'p2' and d.p2 = p_user)),
        'lost', count(*) filter (where (d.result = 'p2' and d.p1 = p_user) or (d.result = 'p1' and d.p2 = p_user)),
        'draw', count(*) filter (where d.result = 'draw'))
      from public.sector_duels d
      where d.status = 'finished' and (d.p1 = p_user or d.p2 = p_user)),
    'vs', case when me is null or me = p_user then null else (
      select jsonb_build_object(
        'me', count(*) filter (where (d.result = 'p1' and d.p1 = me) or (d.result = 'p2' and d.p2 = me)),
        'them', count(*) filter (where (d.result = 'p1' and d.p1 = p_user) or (d.result = 'p2' and d.p2 = p_user)),
        'draw', count(*) filter (where d.result = 'draw'))
      from public.sector_duels d
      where d.status = 'finished' and ((d.p1 = me and d.p2 = p_user) or (d.p1 = p_user and d.p2 = me))) end,
    'durak', (
      select jsonb_build_object('games', count(*), 'first', count(*) filter (where dp.place = 1))
      from public.durak_players dp
      join public.durak_rooms r on r.id = dp.room_id
      where dp.user_id = p_user and r.status = 'finished' and not r.test)
  );
end $function$;
revoke all on function public.member_profile(uuid) from public, anon;
grant execute on function public.member_profile(uuid) to authenticated;
