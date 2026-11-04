-- Награда за ответ на вопрос дня и за слово дня: 30 монет вместо 20.
-- Срабатывает только при новом ответе (триггер AFTER INSERT на answers),
-- поэтому прошлые ответы не пересчитываются. Бонусы за серию не меняются.

create or replace function public.award_answer_points()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare s integer; bonus integer;
begin
  insert into public.points_ledger (user_id, amount, reason, ref, day)
  values (new.user_id, 30, new.kind, new.day::text, new.day)
  on conflict do nothing;
  if (select count(*) from public.answers a where a.user_id = new.user_id and a.day = new.day) = 1 then
    s := public.streak_on(new.user_id, new.day);
    bonus := case s when 3 then 20 when 7 then 50 when 30 then 150 when 100 then 500 else 0 end;
    if bonus > 0 then
      insert into public.points_ledger (user_id, amount, reason, ref, day)
      values (new.user_id, bonus, 'streak', s || ':' || new.day, new.day)
      on conflict do nothing;
    end if;
  end if;
  return new;
end $function$;
