-- Данные для проверки мини-профиля (people.js): ответы и серия, реакции, рекорды игр, дуэли, витрина.
-- Запуск после сборки базы: psql … -d ИМЯ -f profile-seed.sql
do $$
declare a uuid; f uuid; cid integer; k bigint; i integer;
begin
  select user_id into a from public.admins limit 1;
  select id into f from public.profiles where id <> a order by created_at limit 1;
  update public.profiles set zodiac = 'leo', created_at = '2026-10-03 12:00+03' where id = f;
  for i in 0 .. 4 loop insert into public.answers (user_id, day, kind, body) values (f, public.today_tallinn() - i, 'question', 'ответ ' || i); end loop;
  insert into public.answers (user_id, day, kind, body) values (a, public.today_tallinn() - 1, 'question', 'вчера');
  insert into public.reactions (answer_id, user_id, emoji) select x.id, a, 'heart' from public.answers x where x.user_id = f limit 3;
  insert into public.game_sessions (user_id, game, finished_at, score, valid) values (f, 'sector', now(), 1240, true), (f, 'sector', now(), 2000, false);
  insert into public.zigzag_sessions (user_id, finished_at, score, valid) values (f, now(), 315, true);
  insert into public.sector_duels (p1, p2, stake, status, result, finished_at) values
    (a, f, 10, 'finished', 'p1', now()), (f, a, 10, 'finished', 'p2', now()), (f, a, 10, 'finished', 'p1', now()), (a, f, 10, 'finished', 'draw', now());
  -- три карточки другу и на витрину
  for cid in select id from public.cards order by sort desc limit 3 loop
    select id into k from public.card_copies where card_id = cid order by serial limit 1;
    update public.card_copies set state = 'owned', owner_id = f, obtained_at = now() where id = k;
    insert into public.card_showcase (user_id, slot, copy_id) values (f, (select count(*) + 1 from public.card_showcase where user_id = f), k);
  end loop;
end $$;
